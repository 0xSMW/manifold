import { ConsoleGate } from "@/components/console/console-gate";
import { ProviderDetail } from "@/components/providers/provider-detail";

export default async function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsoleGate minRole="editor"><ProviderDetail credentialId={id} /></ConsoleGate>;
}
