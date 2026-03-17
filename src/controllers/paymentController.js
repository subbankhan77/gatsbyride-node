const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { UserCardDetails, Payment, Order } = require('../models');
const { apiResponse } = require('../utils/helpers');

// ─── Add Card ─────────────────────────────────────────────────────────────────
exports.addCard = async (req, res) => {
  try {
    const { card_number, card_holder_name, card_type, expiry_date } = req.body;

    const card = await UserCardDetails.create({
      user_id: req.user.id,
      card_number,
      card_holder_name,
      card_type,
      expiry_date,
      status: 1,
    });

    return apiResponse(res, 201, true, 'Card added', card);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── List Cards ───────────────────────────────────────────────────────────────
exports.listCards = async (req, res) => {
  try {
    const cards = await UserCardDetails.findAll({
      where: { user_id: req.user.id, status: 1 },
    });
    return apiResponse(res, 200, true, 'Cards', cards);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Delete Card ──────────────────────────────────────────────────────────────
exports.deleteCard = async (req, res) => {
  try {
    const { card_id } = req.body;
    await UserCardDetails.update(
      { status: 0 },
      { where: { id: card_id, user_id: req.user.id } }
    );
    return apiResponse(res, 200, true, 'Card deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Charge Payment via Stripe ────────────────────────────────────────────────
exports.chargePayment = async (req, res) => {
  try {
    const { order_id, amount, payment_method_id } = req.body;

    const order = await Order.findOne({
      where: { id: order_id, customer_id: req.user.id }, // sirf apna order pay kar sakta hai
    });
    if (!order) return apiResponse(res, 404, false, 'Order not found');

    // Amount validate karo — customer apni marzi ka amount charge nahi kar sakta
    const expectedAmount = parseFloat(order.grand_total || order.total || 0);
    const requestedAmount = parseFloat(amount);
    if (Math.abs(requestedAmount - expectedAmount) > 0.01) {
      return apiResponse(res, 422, false, `Invalid amount. Expected: ${expectedAmount}`);
    }

    // Duplicate payment check
    const existing = await Payment.findOne({ where: { order_id, status: 1 } });
    if (existing) return apiResponse(res, 409, false, 'Payment already done for this order');

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(requestedAmount * 100), // cents mein
      currency: 'usd',
      payment_method: payment_method_id,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    });

    const payment = await Payment.create({
      driver_id: order.driver_id,
      order_id,
      transaction_id: paymentIntent.id,
      total: requestedAmount,
      status: paymentIntent.status === 'succeeded' ? 1 : 0,
    });

    if (paymentIntent.status === 'succeeded') {
      await order.update({ status: 7 }); // COMPLETE
    }

    return apiResponse(res, 200, true, 'Payment processed', { payment, paymentIntent });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

// ─── Driver Payment Confirmation ──────────────────────────────────────────────
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

    await order.update({ status: 7 }); // COMPLETE

    return apiResponse(res, 200, true, 'Payment confirmed', payment);
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};
