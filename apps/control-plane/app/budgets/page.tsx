import { ConsoleGate } from "@/components/console/console-gate";
import { BudgetsConsole } from "@/components/budgets/budgets-console";

export default function BudgetsPage() {
  return <ConsoleGate enterpriseOnly minRole="editor"><BudgetsConsole /></ConsoleGate>;
}
