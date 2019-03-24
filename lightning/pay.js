const {createHash} = require('crypto');

const {chanFormat} = require('bolt07');
const {chanNumber} = require('bolt07');
const {encodeChanId} = require('bolt07');

const {broadcastResponse} = require('./../async-util');
const payPaymentRequest = require('./pay_payment_request');
const rowTypes = require('./conf/row_types');

const chanIdMatch = /(\d+[x\:]\d+[\:x]\d+)/gim;
const chanSplit = /[\:x\,]/;
const decBase = 10;

/** Make a payment.

  Either a payment path or a BOLT 11 payment request is required

  For paying to private destinations along set paths, a public key in the route
  hops is required to form the route.

  {
    [fee]: <Maximum Additional Fee Tokens To Pay Number>
    lnd: <LND GRPC API Object>
    [log]: <Log Function> // Required if wss is set
    [out]: <Force Payment Through Outbound Standard Channel Id String>
    [path]: {
      id: <Payment Hash Hex String>
      routes: [{
        fee: <Total Fee Tokens To Pay Number>
        fee_mtokens: <Total Fee Millitokens To Pay String>
        hops: [{
          channel: <Standard Format Channel Id String>
          channel_capacity: <Channel Capacity Tokens Number>
          fee: <Fee Number>
          fee_mtokens: <Fee Millitokens String>
          forward: <Forward Tokens Number>
          forward_mtokens: <Forward Millitokens String>
          [public_key]: <Public Key Hex String>
          timeout: <Timeout Block Height Number>
        }]
        mtokens: <Total Millitokens To Pay String>
        timeout: <Expiration Block Height Number>
        tokens: <Total Tokens To Pay Number>
      }]
    }
    [request]: <BOLT 11 Payment Request String>
    [tokens]: <Total Tokens To Pay to Payment Request Number>
    [wss]: [<Web Socket Server Object>]
  }

  @returns via cbk
  {
    fee: <Fee Paid Tokens Number>
    fee_mtokens: <Fee Paid Millitokens String>
    hops: [{
      channel: <Standard Format Channel Id String>
      channel_capacity: <Hop Channel Capacity Tokens Number>
      fee_mtokens: <Hop Forward Fee Millitokens String>
      forward_mtokens: <Hop Forwarded Millitokens String>
      timeout: <Hop CLTV Expiry Block Height Number>
    }]
    id: <Payment Hash Hex String>
    is_confirmed: <Is Confirmed Bool>
    is_outgoing: <Is Outoing Bool>
    mtokens: <Total Millitokens Sent String>
    secret: <Payment Secret Preimage Hex String>
    tokens: <Total Tokens Sent Number>
    type: <Type String>
  }
*/
module.exports = ({fee, lnd, log, out, path, request, tokens, wss}, cbk) => {
  if (!path && !request) {
    return cbk([400, 'ExpectedPathOrRequestToPay']);
  }

  if (!lnd || !lnd.sendPaymentSync || !lnd.sendToRouteSync) {
    return cbk([400, 'ExpectedLndForPaymentExecution']);
  }

  if (!!path && !path.id) {
    return cbk([400, 'ExpectedPaymentHashStringToExecutePayment']);
  }

  if (!!path && (!Array.isArray(path.routes) || !path.routes.length)) {
    return cbk([400, 'ExpectedRoutesToExecutePaymentOver']);
  }

  // Exit early when the invoice is defined
  if (!path) {
    return payPaymentRequest({fee, lnd, log, out, request, tokens, wss}, cbk);
  }

  try {
    path.routes.forEach(route => {
      return route.hops.forEach(({channel}) => chanNumber({channel}));
    });
  } catch (err) {
    return cbk([400, 'ExpectedValidRouteChannelIds', err]);
  }

  lnd.sendToRouteSync({
    payment_hash: Buffer.from(path.id, 'hex'),
    payment_hash_string: path.id,
    routes: path.routes
      .filter(route => fee === undefined || route.fee <= fee)
      .map(route => {
        return {
          hops: route.hops.map(hop => {
            return {
              amt_to_forward: hop.forward.toString(),
              amt_to_forward_msat: hop.forward_mtokens,
              chan_id: chanNumber({channel: hop.channel}).number,
              chan_capacity: hop.channel_capacity.toString(),
              expiry: hop.timeout,
              fee: hop.fee.toString(),
              fee_msat: hop.fee_mtokens,
              pub_key: hop.public_key || undefined,
            };
          }),
          total_amt: route.tokens.toString(),
          total_amt_msat: route.mtokens,
          total_fees: route.fee.toString(),
          total_fees_msat: route.fee_mtokens,
          total_time_lock: route.timeout,
        };
      }),
  },
  (err, res) => {
    if (!!err) {
      return cbk([503, 'PaymentError', err]);
    }

    if (!res) {
      return cbk([503, 'ExpectedResponseWhenSendingPayment']);
    }

    if (res.payment_error === 'UnknownPaymentHash') {
      return cbk([404, 'UnknownPaymentHash']);
    }

    if (res.payment_error === 'payment is in transition') {
      return cbk([409, 'PaymentIsPendingResolution']);
    }

    if (res.payment_error === 'unable to find a path to destination') {
      return cbk([503, 'UnknownPathToDestination']);
    }

    const paymentError = res.payment_error || '';

    const [chanFailure] = paymentError.match(chanIdMatch) || [];
    let failChanId;

    if (!!chanFailure) {
      const chanId = chanFailure.split(chanSplit);

      try {
        const [blockHeight, blockIndex, outputIndex] = chanId;

        const encodedFailChanId = encodeChanId({
          block_height: parseInt(blockHeight, decBase),
          block_index: parseInt(blockIndex, decBase),
          output_index: parseInt(outputIndex, decBase),
        });

        failChanId = encodedFailChanId.channel;
      } catch (err) {
        // Ignore errors when parsing of unstructured error message fails.
      }
    }

    if (/UnknownPaymentHash/.test(res.payment_error)) {
      return cbk([404, 'UnknownPaymentHash']);
    }

    if (/ChannelDisabled/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'NextHopChannelDisabled', {channel: failChanId}]);
    }

    if (/ChannelDisabled/.test(res.payment_error)) {
      return cbk([503, 'NextHopChannelDisabled', res.payment_route]);
    }

    if (/ExpiryTooFar/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'ExpiryTooFar', {channel: failChanId}]);
    }

    if (/ExpiryTooFar/.test(res.payment_error)) {
      return cbk([503, 'ExpiryTooFar', res.payment_error]);
    }

    if (/ExpiryTooSoon/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'RejectedTooNearTimeout', {channel: failChanId}]);
    }

    if (/ExpiryTooSoon/.test(res.payment_error)) {
      return cbk([503, 'RejectedTooNearTimeout', res.payment_error]);
    }

    if (/FeeInsufficient/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'RejectedUnacceptableFee', {channel: failChanId}]);
    }

    if (/FeeInsufficient/.test(res.payment_error)) {
      return cbk([503, 'RejectedUnacceptableFee', res.payment_error]);
    }

    if (/FinalIncorrectCltvExpiry/.test(res.payment_error)) {
      return cbk([503, 'ExpiryTooFar', res.payment_error]);
    }

    if (/IncorrectCltvExpiry/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'RejectedUnacceptableCltv', {channel: failChanId}]);
    }

    if (/IncorrectCltvExpiry/.test(res.payment_error)) {
      return cbk([503, 'RejectedUnacceptableCltv', res.payment_error]);
    }

    if (/TemporaryChannelFailure/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'TemporaryChannelFailure', {channel: failChanId}]);
    }

    if (/TemporaryChannelFailure/.test(res.payment_error)) {
      return cbk([503, 'TemporaryChannelFailure', res.payment_error]);
    }

    if (/TemporaryNodeFailure/.test(res.payment_error)) {
      return cbk([503, 'TemporaryNodeFailure', res.payment_error]);
    }

    if (/UnknownNextPeer/.test(res.payment_error) && !!failChanId) {
      return cbk([503, 'UnknownNextHopChannel', {channel: failChanId}]);
    }

    if (/UnknownNextPeer/.test(res.payment_error)) {
      return cbk([503, 'UnknownNextHopChannel', res.payment_error]);
    }

    if (!!res.payment_error) {
      return cbk([503, 'UnableToCompletePayment', res.payment_error]);
    }

    if (!res.payment_route) {
      return cbk([503, 'ExpectedPaymentRouteInformation', res]);
    }

    if (!Array.isArray(res.payment_route.hops)) {
      return cbk([503, 'ExpectedPaymentRouteHops']);
    }

    if (!Buffer.isBuffer(res.payment_preimage)) {
      return cbk([503, 'ExpectedPaymentPreimageBuffer']);
    }

    if (!Array.isArray(res.payment_route.hops)) {
      return cbk([503, 'ExpectedPaymentRouteHops']);
    }

    if (res.payment_route.total_amt === undefined) {
      return cbk([503, 'ExpectedPaymentTotalSentAmount']);
    }

    if (res.payment_route.total_amt_msat === undefined) {
      return cbk([503, 'ExpectedPaymentTotalMillitokensSentAmount']);
    }

    if (res.payment_route.total_fees === undefined) {
      return cbk([503, 'ExpectedRouteFeesPaidValue']);
    }

    if (res.payment_route.total_fees_msat === undefined) {
      return cbk([503, 'ExpectedRouteFeesMillitokensPaidValue']);
    }

    const {hops} = res.payment_route;

    try {
      hops.forEach(hop => chanFormat({number: hop.chan_id}));
    } catch (err) {
      return cbk([503, 'ExpectedNumericChannelIdInPaymentResponse', err]);
    }

    const row = {
      fee: parseInt(res.payment_route.total_fees, decBase),
      fee_mtokens: res.payment_route.total_fees_msat,
      hops: res.payment_route.hops.map(hop => {
        return {
          channel_capacity: parseInt(hop.chan_capacity, decBase),
          channel: chanFormat({number: hop.chan_id}).channel,
          fee_mtokens: hop.fee_msat,
          forward_mtokens: hop.amt_to_forward_msat,
          timeout: hop.expiry,
        };
      }),
      id: createHash('sha256').update(res.payment_preimage).digest('hex'),
      is_confirmed: true,
      is_outgoing: true,
      mtokens: res.payment_route.total_amt_msat,
      secret: res.payment_preimage.toString('hex'),
      tokens: parseInt(res.payment_route.total_amt, decBase),
      type: rowTypes.channel_transaction,
    };

    if (!!wss) {
      broadcastResponse({log, row, wss});
    }

    return cbk(null, row);
  });
};
