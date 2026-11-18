import Type, { type Static } from 'typebox';

// A block of numbers kept as a file (SCHEMAS.md section 3). The names and ranges of the numbers are declared by the
// game in code (`tuningKind`, a later milestone); the file schema only says "kind, an optional note, and numbers".
export const tuningSchema = Type.Object(
  { kind: Type.Literal('tuning'), note: Type.Optional(Type.String()) },
  { additionalProperties: Type.Number(), title: 'Hull tuning block' },
);

// Static<> drops the numbers (the schema's additionalProperties), so the value type is written out: read a number
// by name, `kind` and `note` are the only strings.
export type Tuning = Static<typeof tuningSchema> & { readonly [name: string]: number | string | undefined };
