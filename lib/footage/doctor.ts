import { CutFootageError } from "./diagnostics";
import {
  inspectCutFootageLocalInstall,
  startCutFootageLocalSidecar,
  type CutFootageLocalOperations,
  type CutFootageLocalStartOptions,
} from "./setup";

export type CutFootageLocalDoctorCheck = Readonly<{
  code: string;
  name: string;
  status: "pass" | "fail";
  detail: string;
  remedy?: string;
}>;

export type CutFootageLocalDoctorReport = Readonly<{
  format: "cut-footage-local-doctor-report";
  version: 1;
  status: "pass" | "fail";
  backend: "local";
  checks: readonly CutFootageLocalDoctorCheck[];
}>;

export type CutFootageLocalDoctorOptions = CutFootageLocalStartOptions & Readonly<{
  operations?: CutFootageLocalOperations;
}>;

function report(status: "pass" | "fail", check: CutFootageLocalDoctorCheck): CutFootageLocalDoctorReport {
  return Object.freeze({
    format: "cut-footage-local-doctor-report", version: 1, status, backend: "local",
    checks: Object.freeze([Object.freeze(check)]),
  });
}

export async function collectCutFootageLocalDoctorReport(options: CutFootageLocalDoctorOptions = {}): Promise<CutFootageLocalDoctorReport> {
  try {
    await inspectCutFootageLocalInstall(options);
    const session = await startCutFootageLocalSidecar(options);
    await session.close();
    return report("pass", {
      code: "CUTFD1000", name: "Local footage backend", status: "pass",
      detail: "The pinned local footage backend is verified and ready for offline use.",
    });
  } catch (error) {
    if (error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_MISSING") {
      return report("fail", {
        code: "CUTFD1001", name: "Local footage backend", status: "fail",
        detail: "The local footage backend is not installed.",
        remedy: "Run cut footage setup --backend local, then rerun footage doctor.",
      });
    }
    return report("fail", {
      code: "CUTFD1002", name: "Local footage backend", status: "fail",
      detail: "The local footage backend could not be verified.",
      remedy: "Repair the immutable local footage backend, then rerun footage doctor.",
    });
  }
}
