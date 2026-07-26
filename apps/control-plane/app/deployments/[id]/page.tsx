import { ConsoleGate } from "@/components/console/console-gate";
import { DeploymentDetail } from "@/components/deployments/deployment-detail";

export default async function DeploymentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <ConsoleGate minRole="admin">
      <DeploymentDetail installationId={id} />
    </ConsoleGate>
  );
}
