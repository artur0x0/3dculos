/* tslint:disable */
/* eslint-disable */

export function cancel(): void;

export function capabilities(): any;

export function dispose(): void;

export function solve(study: any, positions: Float32Array, indices: Uint32Array, face_ids: Uint32Array, material: any, profile: string): any;

/**
 * Linear-elastic TET10 solve.
 *
 * `mesh.nodes` is a Float64Array or Float32Array of xyz coordinates in
 * millimetres. `mesh.elements` is a Uint32Array, 10 indices per element
 * (VTK order). `material` matches the stub (`E_MPa`, `nu`, optional
 * `yield_MPa`). `bcs` carries typed arrays:
 *
 * - `fixedDofs` / `fixedValues`: prescribed DOFs (`node * 3 + axis`). Missing
 *   values mean 0.
 * - `fixedNodes`: nodes whose three DOFs are fixed at 0.
 * - `forceNodes` / `forceValues`: nodal forces, three components per node, N.
 * - `pressureFaces` / `pressures`: 6 node indices per face and one pressure
 *   per face, MPa. Positive pressure pushes against the right-hand normal of
 *   the first three nodes.
 *
 * `options.solver` is `"auto"` (default), `"cholesky"` or `"pcg"`. Auto uses
 * supernodal Cholesky at or below `choleskyMaxDofs` (default 20000 free DOFs)
 * and Jacobi PCG above that. `tol` and `maxIter` apply to PCG.
 */
export function solve_tet10(mesh: any, material: any, bcs: any, options: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly cancel: () => void;
    readonly capabilities: (a: number) => void;
    readonly dispose: () => void;
    readonly solve: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly solve_tet10: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
