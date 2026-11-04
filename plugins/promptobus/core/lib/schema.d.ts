export interface SchemaNode {
    [keyword: string]: unknown;
    $id?: string;
    $ref?: string;
    $defs?: Record<string, SchemaNode>;
    oneOf?: SchemaNode[];
    type?: string | string[];
    required?: string[];
    properties?: Record<string, SchemaNode>;
    additionalProperties?: boolean | SchemaNode;
    propertyNames?: SchemaNode;
    items?: SchemaNode | SchemaNode[];
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
}
export interface SchemaError {
    at: string;
    note: string;
}
/** What of this schema the reader does not implement — a keyword by name, or a shape of one
 * it reads only bare; sorted, and empty when the schema is covered whole. */
export declare function unsupportedKeywords(schema: unknown): string[];
/** Where the document breaks its schema: `{ at, note }` per fault, empty — it is accepted.
 * An unimplemented keyword throws: a partial verdict given as a pass is what this refuses. */
export declare function schemaErrors(schema: SchemaNode, document: unknown): SchemaError[];
/** The faults as one line, for a refusal a person reads. */
export declare function sayErrors(errors: SchemaError[]): string;
