import { Router, Route } from "@solidjs/router";

import Dashboard from "./routes/index";
import BacktestList from "./routes/backtests/index";
import NewBacktest from "./routes/backtests/new";
import BacktestDetail from "./routes/backtests/[id]";
import BacktestComparePage from "./routes/backtests/compare";
import CandidateDetailPage from "./routes/candidates/[id]";
import CandidateRegistryPage from "./routes/candidates/index";
import ExperimentsIndexPage from "./routes/experiments/index";
import ExperimentDetailPage from "./routes/experiments/[id]";
import AlphaLabIndexPage from "./routes/alpha-lab/index";
import AlphaLabCampaignPage from "./routes/alpha-lab/[id]";
import PaperSessionDetailPage from "./routes/paper-sessions/[id]";
import PaperTradingGuidePage from "./routes/paper-sessions/guide";
import PaperSessionListPage from "./routes/paper-sessions/index";
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
      <Route path="/candidates" component={CandidateRegistryPage} />
      <Route path="/candidates/:id" component={CandidateDetailPage} />
      <Route path="/paper-sessions" component={PaperSessionListPage} />
      <Route path="/paper-sessions/guide" component={PaperTradingGuidePage} />
      <Route path="/paper-sessions/:id" component={PaperSessionDetailPage} />
      <Route path="/experiments" component={ExperimentsIndexPage} />
      <Route path="/experiments/:id" component={ExperimentDetailPage} />
      <Route path="/alpha-lab" component={AlphaLabIndexPage} />
      <Route path="/alpha-lab/:id" component={AlphaLabCampaignPage} />
    </Router>
  );
}
