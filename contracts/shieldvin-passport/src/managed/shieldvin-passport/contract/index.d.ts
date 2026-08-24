import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  newReading(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  previousReading(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  previousSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  newSalt(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  registerPassport(context: __compactRuntime.CircuitContext<PS>,
                   vinHash_0: Uint8Array,
                   contentRoot_0: Uint8Array,
                   registrarId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  initialiseOdometer(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  recordReading(context: __compactRuntime.CircuitContext<PS>,
                vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveOdometerBelow(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array,
                     bound_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  registerPassport(context: __compactRuntime.CircuitContext<PS>,
                   vinHash_0: Uint8Array,
                   contentRoot_0: Uint8Array,
                   registrarId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  initialiseOdometer(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  recordReading(context: __compactRuntime.CircuitContext<PS>,
                vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveOdometerBelow(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array,
                     bound_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  registerPassport(context: __compactRuntime.CircuitContext<PS>,
                   vinHash_0: Uint8Array,
                   contentRoot_0: Uint8Array,
                   registrarId_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  initialiseOdometer(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  recordReading(context: __compactRuntime.CircuitContext<PS>,
                vinHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  proveOdometerBelow(context: __compactRuntime.CircuitContext<PS>,
                     vinHash_0: Uint8Array,
                     bound_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  passports: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  odometerCommitment: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  registrar: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  readonly readingCount: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
