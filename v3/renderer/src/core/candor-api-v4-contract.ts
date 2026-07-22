type ExpectTrue<Value extends true> = Value;
type ExpectFalse<Value extends false> = Value;

/**
 * This exported compile-time proof fails renderer typechecking if any async
 * CandorApiV4 method can resolve without the complete renderer custody receipt.
 */
export type CandorApiV4CustodyProof = ExpectTrue<
  [CandorApiV4ResponseUnion] extends [RendererCustody] ? true : false
>;

export type CandorApiV4ResponseSetIsNonEmpty = ExpectFalse<
  [CandorApiV4ResponseUnion] extends [never] ? true : false
>;
