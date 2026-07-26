import { ConsoleGate } from "@/components/console/console-gate";
import { LogsConsole } from "@/components/logs/logs-console";

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return <ConsoleGate minRole="viewer"><LogsConsole initialTraceId={traceId} /></ConsoleGate>;
}
