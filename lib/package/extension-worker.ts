import { Worker, type WorkerOptions } from "node:worker_threads";

export type CutExtensionWorkerLike = Readonly<{
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
}>;

export type CutExtensionWorkerController = Readonly<{
  create(source: string, options: WorkerOptions): CutExtensionWorkerLike;
  terminate(worker: CutExtensionWorkerLike): Promise<number>;
}>;

export type CutExtensionWorkerDecoded<T> =
  | Readonly<{ status: "fail"; code: string; message: string }>
  | Readonly<{ status: "pass"; value: T }>;

export type CutExtensionWorkerRequest<T> = Readonly<{
  identity: string;
  maximumConcurrency: number;
  timeoutMs: number;
  terminationConfirmationMs: number;
  source: string;
  options: WorkerOptions;
  decode(message: unknown): CutExtensionWorkerDecoded<T>;
}>;

export const defaultCutExtensionWorkerController: CutExtensionWorkerController = Object.freeze({
  create: (source, options) => new Worker(source, options),
  terminate: (worker) => (worker as Worker).terminate(),
});

export const cutExtensionTerminationConfirmationMs = 250;

const activeExecutions = new Map<string, number>();
const quarantinedIdentities = new Set<string>();

function codedError(code: string, path: string, message: string) {
  return Object.assign(new Error(message), { code, path });
}

function release(identity: string) {
  const current = activeExecutions.get(identity);
  if (current === undefined || current <= 1) activeExecutions.delete(identity);
  else activeExecutions.set(identity, current - 1);
}

export function cutExtensionWorkerIdentityState(identity: string) {
  return Object.freeze({
    active: activeExecutions.get(identity) ?? 0,
    quarantined: quarantinedIdentities.has(identity),
  });
}

export async function runCutExtensionWorker<T>(
  request: CutExtensionWorkerRequest<T>,
  controller: CutExtensionWorkerController = defaultCutExtensionWorkerController,
) {
  if (!Number.isSafeInteger(request.terminationConfirmationMs)
    || request.terminationConfirmationMs < 1
    || request.terminationConfirmationMs > cutExtensionTerminationConfirmationMs) {
    throw codedError(
      "CUT_EXTENSION_WORKER_CONFIGURATION",
      "$worker.terminationConfirmationMs",
      `termination confirmation must be an integer from 1 through the hard ceiling ${cutExtensionTerminationConfirmationMs}ms.`,
    );
  }
  if (quarantinedIdentities.has(request.identity)) {
    throw codedError(
      "CUT_EXTENSION_WORKER_QUARANTINED",
      "$worker",
      "CUT cannot execute an extension identity whose worker termination was not confirmed in the current process.",
    );
  }
  const active = activeExecutions.get(request.identity) ?? 0;
  if (active >= request.maximumConcurrency) {
    throw codedError(
      "CUT_EXTENSION_CONCURRENCY_LIMIT",
      "$.budgets.maximumConcurrency",
      "extension execution exceeds its declared in-process concurrency quota.",
    );
  }
  activeExecutions.set(request.identity, active + 1);

  try {
    const worker = controller.create(request.source, request.options);
    return await new Promise<T>((accept, reject) => {
      let settled = false;
      let received: CutExtensionWorkerDecoded<T> | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const terminateThenReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let terminationSettled = false;
        const failUnconfirmed = () => {
          if (terminationSettled) return;
          terminationSettled = true;
          clearTimeout(confirmationTimer);
          quarantinedIdentities.add(request.identity);
          reject(codedError(
            "CUT_EXTENSION_WORKER_TERMINATION",
            "$worker",
            "CUT could not confirm extension worker termination; this extension identity is quarantined in the current process.",
          ));
        };
        const confirmationTimer = setTimeout(failUnconfirmed, request.terminationConfirmationMs);
        let termination: Promise<number>;
        try {
          termination = controller.terminate(worker);
        } catch {
          failUnconfirmed();
          return;
        }
        void termination.then(
          () => {
            if (terminationSettled) return;
            terminationSettled = true;
            clearTimeout(confirmationTimer);
            reject(error);
          },
          failUnconfirmed,
        );
      };
      const timer = setTimeout(() => {
        terminateThenReject(codedError(
          "CUT_EXTENSION_TIMEOUT",
          "$.budgets.timeoutMs",
          `CUT extension exceeded its ${request.timeoutMs}ms wall-clock budget.`,
        ));
      }, request.timeoutMs);
      worker.once("message", (message: unknown) => {
        try {
          received = request.decode(message);
        } catch (error) {
          terminateThenReject(error);
        }
      });
      worker.once("error", () => terminateThenReject(codedError(
        "CUT_EXTENSION_WORKER",
        "$worker",
        "CUT extension worker failed before a closed result.",
      )));
      worker.once("exit", (code) => {
        if (settled) return;
        const result = received;
        if (code !== 0 || !result) {
          finish(() => reject(codedError(
            "CUT_EXTENSION_WORKER",
            "$worker",
            "CUT extension worker exited without a closed successful result.",
          )));
          return;
        }
        if (result.status === "fail") {
          finish(() => reject(codedError(result.code, "$worker", result.message)));
          return;
        }
        finish(() => accept(result.value));
      });
    });
  } finally {
    release(request.identity);
  }
}
