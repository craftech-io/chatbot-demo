// Traducción del `slug` de `client.config.ts` a los alfabetos de nombres que
// exige cada servicio. Único lugar donde vive esa lógica: los módulos de infra
// usan estas constantes en vez de repetir un prefijo literal.
//
// Solo el PREFIJO sale de acá; el sufijo de stage se sanea en cada módulo, que
// es donde está documentado por qué (cada recurso tolera un alfabeto distinto).
import { cliente } from "../../client.config";

// El slug tiene que venir en kebab-case minúsculas empezando por letra: con esa
// forma las dos traducciones de abajo son seguras. Se valida en synth porque el
// error del servicio aparecería recién al crear el recurso, como un
// ValidationException opaco a mitad del deploy.
const FORMA_SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
if (!FORMA_SLUG.test(cliente.slug)) {
  throw new Error(
    `client.config.ts: slug inválido (${JSON.stringify(cliente.slug)}). Se espera ` +
      `kebab-case en minúsculas empezando por letra, p.ej. "acme-chat".`,
  );
}

// Alfabeto de ECR (minúsculas, dígitos y guiones — el autoname de Pulumi parte
// del nombre lógico en PascalCase y lo rechaza), del Guardrail
// (`[0-9a-zA-Z-_]+`) y del Gateway (`([0-9a-zA-Z][-]?){1,48}`: guiones no
// consecutivos ni al final). Un slug con la forma validada arriba ya cumple los
// tres, así que esto es la identidad; el saneo queda como red si algún día se
// relaja la validación.
export const slugKebab = cliente.slug
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Alfabeto de AgentCore Runtime y Memory: `[a-zA-Z][a-zA-Z0-9_]*` — acepta `_`
// y NO acepta `-`. Se pasa el slug a camelCase (`acme-chat` -> `acmeChat`) en
// vez de cambiar los guiones por `_`: es la convención con la que están
// desplegados los nombres actuales. Arranca con letra porque el slug validado
// arranca con letra.
export const slugCamel = cliente.slug
  .split(/[^a-zA-Z0-9]+/)
  .filter(Boolean)
  .map((parte, i) =>
    i === 0 ? parte.toLowerCase() : parte[0].toUpperCase() + parte.slice(1).toLowerCase(),
  )
  .join("");
