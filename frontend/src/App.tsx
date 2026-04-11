import { Router, Route } from "@solidjs/router";

import Dashboard from "./routes/index";
import BacktestList from "./routes/backtests/index";
import NewBacktest from "./routes/backtests/new";
import BacktestDetail from "./routes/backtests/[id]";
import BacktestComparePage from "./routes/backtests/compare";
import ReplayLabPage from "./routes/replay";
import ReplayComparePage from "./routes/replay-compare";
import ReplaySessionListPage from "./routes/replay-sessions";

export default function App() {
  return (
    <Router>
      <Route path="/" component={Dashboard} />
      <Route path="/replay" component={ReplayLabPage} />
      <Route path="/replay/:id/compare" component={ReplayComparePage} />
      <Route path="/replay/:id" component={ReplayLabPage} />
      <Route path="/replay-sessions" component={ReplaySessionListPage} />
      <Route path="/backtests" component={BacktestList} />
      <Route path="/backtests/new" component={NewBacktest} />
      <Route path="/backtests/compare" component={BacktestComparePage} />
      <Route path="/backtests/:id" component={BacktestDetail} />
    </Router>
  );
}
