const stripe = require('stripe')(process.env.STRIPE_SECRET);
const { UserCardDetails, Payment, Order } = require('../models');
const { apiResponse } = require('../utils/helpers');

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
    await UserCardDetails.update(
      { status: 0 },
      { where: { id: card_id, user_id: req.user.id } }
    );
    return apiResponse(res, 200, true, 'Card deleted');
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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

    const existing = await Payment.findOne({ where: { order_id, status: 1 } });
    if (existing) return apiResponse(res, 409, false, 'Payment already done for this order');

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(requestedAmount * 100),
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
      await order.update({ status: 7 });
    }

    return apiResponse(res, 200, true, 'Payment processed', { payment, paymentIntent });
  } catch (err) {
    return apiResponse(res, 500, false, err.message);
  }
};

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
