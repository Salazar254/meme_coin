declare module "onnxruntime-node" {
  export type TensorType = "float32" | "int64";

  export class Tensor {
    constructor(type: "float32", data: Float32Array, dims: readonly number[]);
    constructor(type: "int64", data: BigInt64Array, dims: readonly number[]);
    type: TensorType;
    data: Float32Array | BigInt64Array | number[];
    dims: readonly number[];
  }

  export interface InferenceSession {
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  }

  export namespace InferenceSession {
    function create(path: string, options?: {
      executionProviders?: string[];
      graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
      intraOpNumThreads?: number;
      interOpNumThreads?: number;
    }): Promise<InferenceSession>;
  }
}
