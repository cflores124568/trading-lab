import { lazy } from "solid-js";
import { Router, Route } from "@solidjs/router";

const Dashboard = lazy(() => import("./routes/index"));
const BacktestList = lazy(() => import("./routes/backtests/index"));
const NewBacktest = lazy(() => import("./routes/backtests/new"));
const BacktestDetail = lazy(() => import("./routes/backtests/[id]"));
const BacktestComparePage = lazy(() => import("./routes/backtests/compare"));
const CandidateDetailPage = lazy(() => import("./routes/candidates/[id]"));
const CandidateRegistryPage = lazy(() => import("./routes/candidates/index"));
const ExperimentsIndexPage = lazy(() => import("./routes/experiments/index"));
const ExperimentDetailPage = lazy(() => import("./routes/experiments/[id]"));
const AlphaLabIndexPage = lazy(() => import("./routes/alpha-lab/index"));
const AlphaLabCampaignPage = lazy(() => import("./routes/alpha-lab/[id]"));
const PaperSessionDetailPage = lazy(() => import("./routes/paper-sessions/[id]"));
const PaperTradingGuidePage = lazy(() => import("./routes/paper-sessions/guide"));
const PaperSessionListPage = lazy(() => import("./routes/paper-sessions/index"));
const ReplayLabPage = lazy(() => import("./routes/replay"));
const ReplayComparePage = lazy(() => import("./routes/replay-compare"));
const ReplaySessionListPage = lazy(() => import("./routes/replay-sessions"));
const NotFoundPage = lazy(() => import("./routes/not-found"));
import RouteErrorBoundary from "./components/RouteErrorBoundary";

export default function App() {
  return (
    <Router root={RouteErrorBoundary}>
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
      <Route path="*" component={NotFoundPage} />
    </Router>
  );
}
