import { readFile } from 'node:fs/promises';
import ts from 'typescript';

export async function resolve(specifier, context, next) {
  try { return await next(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.(m?js|json|tsx?)$/.test(specifier)) {
      for (const suffix of ['.ts', '.tsx']) {
        try { return await next(specifier + suffix, context); } catch { /* Try next extension. */ }
      }
    }
    throw error;
  }
}

export async function load(url, context, next) {
  if (/\.(ts|tsx|json)$/.test(url) && !url.includes('/node_modules/')) {
    const source = await readFile(new URL(url), 'utf8');
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${source}`, shortCircuit: true };
    const { outputText } = ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL', '"./"'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      fileName: url,
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  }
  return next(url, context);
}
