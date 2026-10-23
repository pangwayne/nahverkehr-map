import { startBoard } from "./board";
import { createMap } from "./map";
import { closeOnEmptyMapTap } from "./panel";
import { resetStatus } from "./status";
import { startTripCard } from "./tripcard";

const mapEl = document.querySelector<HTMLElement>("#map")!;

resetStatus();
const map = createMap(mapEl);
// Order matters: the board's stop layers go first, the trip card puts its route line under them
// and its vehicle on top of everything.
const board = startBoard(map, (trip) => card.showTrip(trip));
const card = startTripCard(map, (stop) => void board.showStop(stop));
closeOnEmptyMapTap(map, ["vehicle-dot", "stop-hit", "trip-route-line", "trip-stop-dot"]);
