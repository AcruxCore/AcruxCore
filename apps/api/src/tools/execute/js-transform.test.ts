import { compileTransform, evaluateTransform, TransformError } from './js-transform';

describe('sandboxed JS transforms', () => {
  it('compiles and evaluates a transform', async () => {
    const c = compileTransform('function transform(input) { return { q: input.city, u: "metric" }; }');
    await expect(evaluateTransform(c, { city: 'Paris' }, 1000)).resolves.toEqual({ q: 'Paris', u: 'metric' });
  });

  it('throws a TransformError on a syntax error at compile time', () => {
    expect(() => compileTransform('function transform(input) { return {')).toThrow(TransformError);
  });

  it('unwraps an envelope in a response transform', async () => {
    const c = compileTransform('function transform(input) { return input.body.data; }');
    await expect(
      evaluateTransform(c, { status: 200, headers: {}, body: { data: { tempC: 18 } } }, 1000),
    ).resolves.toEqual({ tempC: 18 });
  });

  it('has no bridged host access — require throws inside the isolate', async () => {
    const c = compileTransform('function transform(input) { require("fs"); return input; }');
    await expect(evaluateTransform(c, {}, 1000)).rejects.toBeInstanceOf(TransformError);
  });

  it('rejects a runtime error inside the transform', async () => {
    const c = compileTransform('function transform(input) { throw new Error("boom"); }');
    await expect(evaluateTransform(c, {}, 1000)).rejects.toBeInstanceOf(TransformError);
  });

  it('times out an infinite loop instead of hanging', async () => {
    const c = compileTransform('function transform(input) { while (true) {} }');
    await expect(evaluateTransform(c, {}, 200)).rejects.toBeInstanceOf(TransformError);
  }, 10_000);
});
