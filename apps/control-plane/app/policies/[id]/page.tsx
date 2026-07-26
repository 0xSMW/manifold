import { ConsoleGate } from "@/components/console/console-gate";
import { PolicyDetail } from "@/components/policies/policies-console";

export default async function PolicyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsoleGate enterpriseOnly minRole="editor"><PolicyDetail policyId={id} /></ConsoleGate>;
}
