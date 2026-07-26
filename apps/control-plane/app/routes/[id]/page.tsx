import { ConsoleGate } from "@/components/console/console-gate";
import { RouteDetail } from "@/components/routes/route-detail";

export default async function RouteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <ConsoleGate minRole="editor">
      <RouteDetail routeId={id} />
    </ConsoleGate>
  );
}
