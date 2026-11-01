// Vercel function: every route is rewritten here (vercel.json); the app is compiled to dist/.
// The app is imported lazily so that startup failures (bad env, missing files) come back as a
// JSON error instead of an opaque FUNCTION_INVOCATION_FAILED page.
let handler;

export default async function entry(req, res) {
  try {
    handler ??= (await import('../dist/vercel.js')).default;
    await handler(req, res);
  } catch (err) {
    handler = undefined;
    console.error('function startup failed', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'STARTUP_FAILED', message: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
}
