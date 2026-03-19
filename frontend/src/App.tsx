import { Router, Route } from "@solidjs/router";
import Dashboard from "./routes/index";

export default function App() {
  return (
    <Router>
      <Route path="/" component={Dashboard} />
    </Router>
  );
}