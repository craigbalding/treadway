import { Validator } from '@cfworker/json-schema';

// Interpreted validation: extension service workers forbid runtime code generation.
globalThis.TreadwaySchemaValidator = Object.freeze({
  version: '4.1.6',
  create(schema) {
    const validator = new Validator(schema, '2020-12', true);
    return value => validator.validate(value).valid;
  },
});
