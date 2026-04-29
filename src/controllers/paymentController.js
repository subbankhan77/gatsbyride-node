const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { UserCardDetails, Payment, Order, Customer } = require('../models');
const { apiResponse } = require('../utils/helpers');

// Helper: Stripe Customer create ya retrieve karo
async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email || undefined,
    name: (user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim()) || undefined,
    phone: user.phone || undefined,
  });
  await user.update({ stripe_customer_id: customer.id });
  return customer.id;
}

// POST /stripe/setup-intent
// Frontend card save karne se pehle yeh call kare
exports.createSetupIntent = async (req, res) => {
  try {
    const user = await Customer.findByPk(req.user.id);
    if (!user) return apiResponse(res, 404, false, 'User not found');

    const customerId = await getOrCreateStripeCustomer(user);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
    });

    return apiResponse(res, 200, true, 'Setup intent created', {
      client_secret: setupIntent.client_secret,
      customer_id: customerId,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /card/detail/add
exports.addCard = async (req, res) => {
  try {
    const { payment_method_id, card_holder_name } = req.body;
    if (!payment_method_id) return apiResponse(res, 422, false, 'payment_method_id required');

    const pm = await stripe.paymentMethods.retrieve(payment_method_id);
    if (!pm || pm.type !== 'card') {
      return apiResponse(res, 422, false, 'Invalid payment method');
    }

    const existing = await UserCardDetails.findOne({
      where: { user_id: req.user.id, stripe_payment_method_id: payment_method_id, status: 1 },
    });
    if (existing) return apiResponse(res, 409, false, 'Card already added');

    const user = await Customer.findByPk(req.user.id);
    const customerId = await getOrCreateStripeCustomer(user);

    // PaymentMethod ko Stripe Customer se attach karo (agar already attached nahi hai)
    if (!pm.customer) {
      await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    }

    const card = await UserCardDetails.create({
      user_id: req.user.id,
      stripe_payment_method_id: payment_method_id,
      last_four: pm.card?.last4,
      card_type: pm.card?.brand,
      card_holder_name: card_holder_name || pm.billing_details?.name || '',
      status: 1,
    });

    return apiResponse(res, 201, true, 'Card added', {
      id: card.id,
      last_four: card.last_four,
      card_type: card.card_type,
      card_holder_name: card.card_holder_name,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /card/list
exports.listCards = async (req, res) => {
  try {
    const cards = await UserCardDetails.findAll({
      where: { user_id: req.user.id, status: 1 },
      attributes: ['id', 'stripe_payment_method_id', 'last_four', 'card_type', 'card_holder_name'],
    });
    return apiResponse(res, 200, true, 'Cards', cards);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /card/delete
exports.deleteCard = async (req, res) => {
  try {
    const { card_id } = req.body;
    const card = await UserCardDetails.findOne({ where: { id: card_id, user_id: req.user.id, status: 1 } });
    if (!card) return apiResponse(res, 404, false, 'Card not found');

    // Stripe se bhi detach karo
    try {
      await stripe.paymentMethods.detach(card.stripe_payment_method_id);
    } catch (_) {
      // Stripe detach fail ho toh bhi DB se delete karo
    }

    await card.update({ status: 0 });
    return apiResponse(res, 200, true, 'Card deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /driver/payment
exports.chargePayment = async (req, res) => {
  try {
    const { order_id, amount, payment_method_id } = req.body;

    const order = await Order.findOne({
      where: { id: order_id, customer_id: req.user.id },
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const expectedAmount = parseFloat(order.grand_total || order.total || 0);
    const requestedAmount = parseFloat(amount);
    if (Math.abs(requestedAmount - expectedAmount) > 0.01) {
      return apiResponse(res, 422, false, `Invalid amount. Expected: ${expectedAmount}`);
    }

    const existingPayment = await Payment.findOne({ where: { order_id, status: 1 } });
    if (existingPayment) return apiResponse(res, 409, false, 'Payment already done for this order');

    const user = await Customer.findByPk(req.user.id);
    if (!user.stripe_customer_id) {
      return apiResponse(res, 422, false, 'No Stripe customer found. Please add a card first.');
    }

    // Verify card belongs to this user
    const cardRecord = await UserCardDetails.findOne({
      where: { user_id: req.user.id, stripe_payment_method_id: payment_method_id, status: 1 },
    });
    if (!cardRecord) return apiResponse(res, 403, false, 'Payment method not found for this user');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(requestedAmount * 100),
      currency: 'usd',
      customer: user.stripe_customer_id,
      payment_method: payment_method_id,
      confirm: true,
      off_session: true,
    });

    const payment = await Payment.create({
      driver_id: order.driver_id,
      order_id,
      transaction_id: paymentIntent.id,
      total: requestedAmount,
      status: paymentIntent.status === 'succeeded' ? 1 : 0,
    });

    if (paymentIntent.status === 'succeeded') {
      await order.update({ status: 7 });
    }

    return apiResponse(res, 200, true, 'Payment processed', {
      payment_id: payment.id,
      transaction_id: paymentIntent.id,
      status: paymentIntent.status,
    });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /driver/payment/confirmation  (cash payment ke liye)
exports.paymentConfirmation = async (req, res) => {
  try {
    const { order_id, tip } = req.body;

    const order = await Order.findOne({
      where: { id: order_id, driver_id: req.user.id },
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const payment = await Payment.create({
      driver_id: req.user.id,
      order_id,
      tip: tip || 0,
      total: parseFloat(order.grand_total || order.total || 0) + parseFloat(tip || 0),
      status: 1,
    });

    await order.update({ status: 7 });

    return apiResponse(res, 200, true, 'Payment confirmed', payment);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// POST /stripe/webhook  (raw body chahiye - index.js mein handle kiya)
exports.webhookHandler = (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('STRIPE_WEBHOOK_SECRET not set, skipping verification');
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('PaymentIntent succeeded:', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('PaymentIntent failed:', event.data.object.id, event.data.object.last_payment_error?.message);
      break;
    case 'setup_intent.succeeded':
      console.log('SetupIntent succeeded:', event.data.object.id);
      break;
    default:
      console.log(`Unhandled Stripe event: ${event.type}`);
  }

  res.json({ received: true });
};
