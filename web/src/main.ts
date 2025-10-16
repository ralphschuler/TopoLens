import { fetchSnapshot, connectWS } from "./api";
import { CanvasGraph } from "./canvas";

type LiveMessage =
  | { type: "announce"; origin_as: number | null; as_path?: string }
  | { type: "withdraw" }
  | { type: "heartbeat" };

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app root element");
}

const graph = new CanvasGraph(root);

(async () => {
  const snapshot = await fetchSnapshot();
  graph.setSnapshot(snapshot.nodes, snapshot.edges);

  connectWS((message: LiveMessage & Record<string, any>) => {
    if (message.type === "announce") {
      graph.applyAnnounce(message.origin_as ?? null, message.as_path);
    }
  });
})();
