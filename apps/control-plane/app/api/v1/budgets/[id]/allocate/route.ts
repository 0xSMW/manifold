import { authorize } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { runMutationGuard } from "@/lib/mutation-guard";
import { genId } from "@/lib/ids";
import { ManifoldError, jsonBody, ok, wrapInEnvelope } from "@/lib/http";
import { contractBody, contractOk } from "@/lib/contracts";
import { BudgetEndpointContracts } from "@manifold/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validation(path: string, message: string): never {
  throw new ManifoldError({
    status: 422,
    code: "VALIDATION",
    message,
    reasonCodes: [],
    details: { issues: [{ path, message }] },
  });
}

function amount(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number")
    validation(
      "reservedAllowance",
      "reservedAllowance must be a non-negative integer",
    );
  const result = String(value);
  if (!/^\d+$/.test(result) || BigInt(result) > 9_223_372_036_854_775_807n)
    validation(
      "reservedAllowance",
      "reservedAllowance must be a bigint-range non-negative integer",
    );
  return result;
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return wrapInEnvelope(async (requestId) => {
    const principal = await authorize(req, "budgets:write");
    const { id: parentId } = await context.params;
    return runMutationGuard({
      request: req,
      principal,
      requestId,
      handler: async (sql) => {
        const body = await contractBody(req, BudgetEndpointContracts.allocate);
        const keys = Object.keys(body);
        if (
          keys.some((key) => key !== "childId" && key !== "reservedAllowance")
        )
          validation("body", "POST accepts only childId and reservedAllowance");
        if (
          typeof body.childId !== "string" ||
          body.childId.trim().length === 0
        )
          validation("childId", "childId must be a non-empty string");
        const childId = body.childId.trim();
        const reservedAllowance = amount(body.reservedAllowance);
        const result = await (async () => {
          const parent = (
            await sql<
              {
                id: string;
                unit: string;
                window: string;
                limit_amount: string;
              }[]
            >`SELECT id, unit, window, limit_amount::text FROM budget_account WHERE id = ${parentId} AND workspace_id = ${principal.workspaceId} AND disabled_at IS NULL LIMIT 1`
          )[0];
          if (!parent) return { error: "parent" as const };
          const child = (
            await sql<
              {
                id: string;
                parent_id: string | null;
                unit: string;
                window: string;
              }[]
            >`SELECT id, parent_id, unit, window FROM budget_account WHERE id = ${childId} AND workspace_id = ${principal.workspaceId} AND disabled_at IS NULL LIMIT 1`
          )[0];
          if (!child) return { error: "child" as const };
          if (
            child.parent_id !== parentId ||
            child.unit !== parent.unit ||
            child.window !== parent.window
          )
            return { error: "hierarchy" as const };
          const existing = (
            await sql<
              { id: string; reserved_allowance: string }[]
            >`SELECT id, reserved_allowance::text FROM budget_allocation WHERE workspace_id = ${principal.workspaceId} AND parent_id = ${parentId} AND child_id = ${child.id} AND window = ${parent.window} LIMIT 1`
          )[0];
          if (existing) {
            if (existing.reserved_allowance === reservedAllowance)
              return { existing };
            return { error: "immutable" as const };
          }
          const allocated =
            (
              await sql<
                { total: string }[]
              >`SELECT COALESCE(SUM(reserved_allowance), 0)::text AS total FROM budget_allocation WHERE workspace_id = ${principal.workspaceId} AND parent_id = ${parentId} AND window = ${parent.window}`
            )[0]?.total ?? "0";
          if (
            BigInt(allocated) + BigInt(reservedAllowance) >
            BigInt(parent.limit_amount)
          )
            return { error: "exceeds" as const };
          const allocationId = genId("bal");
          await sql`INSERT INTO budget_allocation (id, workspace_id, parent_id, child_id, reserved_allowance, window) VALUES (${allocationId}, ${principal.workspaceId}, ${parentId}, ${child.id}, ${reservedAllowance}, ${parent.window})`;
          await audit(sql, principal, {
            action: "budget.allocate",
            targetKind: "budget_allocation",
            targetId: allocationId,
            requestId,
            detail: {
              parentId,
              childId: child.id,
              reservedAllowance,
              window: parent.window,
              staged: true,
            },
          });
          return { allocationId };
        })();
        if ("error" in result) {
          const details =
            result.error === "exceeds"
              ? {
                  code: "VALIDATION" as const,
                  status: 422,
                  message: "allocation exceeds parent limit",
                  reasonCodes: ["ALLOCATION_EXCEEDS_PARENT"],
                }
              : result.error === "immutable"
                ? {
                    code: "VALIDATION" as const,
                    status: 409,
                    message:
                      "allocations are immutable; the current schema has no allocation revision path",
                    reasonCodes: [],
                  }
                : result.error === "hierarchy"
                  ? {
                      code: "VALIDATION" as const,
                      status: 422,
                      message:
                        "child must be a direct child with the same unit and window",
                      reasonCodes: [],
                    }
                  : {
                      code: "NOT_FOUND" as const,
                      status: 404,
                      message: `${result.error} budget not found`,
                      reasonCodes: [],
                    };
          throw new ManifoldError(details);
        }
        if ("existing" in result && result.existing)
          return contractOk(BudgetEndpointContracts.allocationResponse,
            {
              id: result.existing.id,
              parentId,
              childId,
              reservedAllowance,
              status: "staged",
              publishRequired: true,
              created: false,
            },
            requestId,
          );
        return contractOk(BudgetEndpointContracts.allocationResponse,
          {
            id: result.allocationId,
            parentId,
            childId,
            reservedAllowance,
            status: "staged",
            publishRequired: true,
            activeEnforcement: false,
          },
          requestId,
          201,
        );
      },
    });
  });
}
