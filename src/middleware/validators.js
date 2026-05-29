const { z } = require('zod');

// ─── Schemas ────────────────────────────────────────────────────────

const signupSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters').max(128, 'Password too long'),
    department: z.string().max(100).optional(),
    semester: z.string().max(50).optional(),
  })
});

const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
  })
});

const googleAuthSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Google token is required'),
  })
});

const ratingSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'Note ID must be a number'),
  }),
  body: z.object({
    userId: z.union([z.string(), z.number()]),
    rating: z.number().int().min(1, 'Min rating is 1').max(5, 'Max rating is 5'),
  })
});

const userUpdateSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'User ID must be a number'),
  }),
  body: z.object({
    name: z.string().min(1).max(100).optional(),
    department: z.string().max(100).optional(),
    semester: z.string().max(50).optional(),
    year: z.string().max(50).optional(),
  })
});

const pointsUpdateSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, 'User ID must be a number'),
  }),
  body: z.object({
    points: z.number().int().min(0),
  })
});

// ─── Middleware ──────────────────────────────────────────────────────

/**
 * Express middleware factory that validates req against a Zod schema.
 * Returns 400 with structured errors if validation fails.
 */
function validate(schema) {
  return (req, res, next) => {
    try {
      const toValidate = {};
      if (schema.shape.body) toValidate.body = req.body;
      if (schema.shape.params) toValidate.params = req.params;
      if (schema.shape.query) toValidate.query = req.query;

      schema.parse(toValidate);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: (err.errors || err.issues || []).map(e => ({
            field: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      next(err);
    }
  };
}

module.exports = {
  validate,
  signupSchema,
  loginSchema,
  googleAuthSchema,
  ratingSchema,
  userUpdateSchema,
  pointsUpdateSchema,
};
