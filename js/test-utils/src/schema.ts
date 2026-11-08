import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'

const schemaUrl = new URL('../../../spec/schema/batch.schema.json', import.meta.url)
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as { $id: string }

const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addSchema(schema)
const validateEnvelope = ajv.getSchema(schema.$id)
const validateEvent = ajv.getSchema(`${schema.$id}#/$defs/event`)
if (!validateEnvelope || !validateEvent) throw new Error('could not compile spec/schema/batch.schema.json')

/**
 * Validates a batch the way the ingest server does: the envelope against the
 * schema, then every event against `#/$defs/event`. Returns the error messages.
 */
export function batchSchemaErrors(batch: unknown): string[] {
  const errors: string[] = []
  if (!validateEnvelope!(batch)) {
    errors.push(...(validateEnvelope!.errors ?? []).map((error) => `envelope ${error.instancePath} ${error.message ?? ''}`))
  }
  const events = (batch as { events?: unknown }).events
  if (Array.isArray(events)) {
    events.forEach((event, index) => {
      if (!validateEvent!(event)) {
        errors.push(...(validateEvent!.errors ?? []).map((error) => `events[${index}]${error.instancePath} ${error.message ?? ''}`))
      }
    })
  }
  return errors
}

/** Throws with every schema error, for use in tests. */
export function assertValidBatch(batch: unknown): void {
  const errors = batchSchemaErrors(batch)
  if (errors.length > 0) throw new Error(`batch does not match the schema:\n${errors.join('\n')}`)
}
