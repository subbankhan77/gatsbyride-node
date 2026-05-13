const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { UserCardDetails, Payment, Order, Customer } = require('../models');
const { apiResponse } = require('../utils/helpers');

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

exports.createPaymentIntent = async (req, res) => {
  try {
    const { order_id, driver_id, amount, tip = '0', currency = 'cad' } = req.body;

    if (!order_id || !amount) {
      return apiResponse(res, 422, false, 'order_id and amount are required');
    }

    const order = await Order.findOne({ where: { id: order_id, customer_id: req.user.id } });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    const totalAmount = Math.round((parseFloat(amount) + parseFloat(tip)) * 100);
    if (totalAmount < 50) return apiResponse(res, 422, false, 'Amount too low (minimum 0.50)');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency: currency.toLowerCase(),
      metadata: {
        order_id: String(order_id),
        driver_id: String(driver_id || order.driver_id || ''),
        customer_id: String(req.user.id),
      },
    });

    return res.json({
      success: 1,
      client_secret: paymentIntent.client_secret,
    });
  } catch (err) {
    return res.status(500).json({ success: 0, message: err.message });
  }
};

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

exports.deleteCard = async (req, res) => {
  try {
    const { card_id } = req.body;
    const card = await UserCardDetails.findOne({ where: { id: card_id, user_id: req.user.id, status: 1 } });
    if (!card) return apiResponse(res, 404, false, 'Card not found');

    await stripe.paymentMethods.detach(card.stripe_payment_method_id).catch(() => {});
    await card.update({ status: 0 });

    return apiResponse(res, 200, true, 'Card deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.chargePayment = async (req, res) => {
  try {
    const { order_id, amount, payment_method_id } = req.body;

    const order = await Order.findOne({ where: { id: order_id, customer_id: req.user.id } });
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

    const cardRecord = await UserCardDetails.findOne({
      where: { user_id: req.user.id, stripe_payment_method_id: payment_method_id, status: 1 },
    });
    if (!cardRecord) return apiResponse(res, 403, false, 'Payment method not found for this user');

    let paymentIntent;
    try {
      paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(requestedAmount * 100),
        currency: 'usd',
        customer: user.stripe_customer_id,
        payment_method: payment_method_id,
        confirm: true,
        off_session: true,
      });
    } catch (stripeErr) {
      if (stripeErr.code === 'authentication_required') {
        return apiResponse(res, 402, false, '3D Secure authentication required', {
          requires_action: true,
          client_secret: stripeErr.raw?.payment_intent?.client_secret,
          payment_intent_id: stripeErr.raw?.payment_intent?.id,
        });
      }
      return apiResponse(res, 402, false, stripeErr.message);
    }

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

    if (paymentIntent.status === 'requires_action') {
      return apiResponse(res, 200, true, '3D Secure required', {
        requires_action: true,
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        payment_id: payment.id,
      });
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

exports.confirmPayment = async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    if (!payment_intent_id) return apiResponse(res, 422, false, 'payment_intent_id required');

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      return apiResponse(res, 402, false, `Payment not completed. Status: ${paymentIntent.status}`);
    }

    await Payment.update({ status: 1 }, { where: { transaction_id: payment_intent_id, status: 0 } });

    const payment = await Payment.findOne({ where: { transaction_id: payment_intent_id } });
    if (payment) {
      await Order.update({ status: 7 }, { where: { id: payment.order_id } });
    }

    return apiResponse(res, 200, true, 'Payment confirmed', { transaction_id: payment_intent_id });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

exports.paymentConfirmation = async (req, res) => {
  try {
    const { order_id, tip } = req.body;

    const order = await Order.findOne({ where: { id: order_id, driver_id: req.user.id } });
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

exports.webhookHandler = async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    try {
      event = JSON.parse(req.body.toString());
    } catch {
      return res.status(400).send('Invalid payload');
    }
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        await Payment.update({ status: 1 }, { where: { transaction_id: pi.id, status: 0 } });
        const payment = await Payment.findOne({ where: { transaction_id: pi.id } });
        if (payment?.order_id) {
          await Order.update({ status: 7 }, { where: { id: payment.order_id } });
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await Payment.update({ status: 2 }, { where: { transaction_id: pi.id, status: 0 } });
        break;
      }
      case 'setup_intent.succeeded':
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  res.json({ received: true });
};
