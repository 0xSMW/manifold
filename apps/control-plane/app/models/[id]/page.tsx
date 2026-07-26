import { ConsoleGate } from "@/components/console/console-gate";
import { ModelDetail } from "@/components/models/model-detail";

export default async function ModelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ConsoleGate minRole="viewer">
      <ModelDetail modelId={id} />
    </ConsoleGate>
  );
}
