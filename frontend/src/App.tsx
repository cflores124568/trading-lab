import { Router, Route } from "@solidjs/router";
import Dashboard from "./routes/index";
import BacktestList from "./routes/backtests/index";
import NewBackTest from "./routes/backtests/new";
import BacktestDetail from "./routes/backtests/[id]";

export default function App() {
  return (
    <Router>
      <Route path="/" component={Dashboard} />
      <Route path="/backtests" component={BacktestList} />
      <Route path="/backtests/new" component={NewBackTest} />
      <Route path="/backtests/:id" component={BacktestDetail} />
    </Router>
  );
}