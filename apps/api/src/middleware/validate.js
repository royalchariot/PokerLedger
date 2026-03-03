import createError from "http-errors";

export function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(createError(400, result.error.issues[0]?.message || "Invalid payload"));
    }
    req.validatedBody = result.data;
    return next();
  };
}
