import { ConsoleGate } from "@/components/console/console-gate";
import { BudgetDetail } from "@/components/budgets/budget-detail";

export default async function BudgetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConsoleGate enterpriseOnly minRole="editor"><BudgetDetail budgetId={id} /></ConsoleGate>;
}
