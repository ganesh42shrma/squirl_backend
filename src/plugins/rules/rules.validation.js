const { z } = require('zod');
const { idParams } = require('../../core/schemas');

const ruleId = z.object({ params: idParams });

module.exports = { ruleId };
