function sendSuccess(res, data, { status = 200, message, meta, events } = {}) {
  return res.status(status).json({
    success: true,
    ...(message && { message }),
    data,
    ...(meta && { meta }),
    // Things that happened as a side effect of the request (XP, level-ups...) for the UI to announce.
    ...(events?.length && { events }),
  });
}

module.exports = { sendSuccess };
