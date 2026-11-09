const { z } = require('zod');
const { email, name, password } = require('../users/user.validation');

const register = z.object({ body: z.object({ name, email, password }) });
const forgotPassword = z.object({ body: z.object({ email }) });
const resetPassword = z.object({ body: z.object({ token: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid or expired link'), password }) });
const login = z.object({ body: z.object({ email, password: z.string().min(1).max(200) }) });

module.exports = { register, login, forgotPassword, resetPassword };
