import { getAgyBinary } from "../agent/agy/binary.ts";
import { settingsStore } from "../store/settings.ts";

export function agyEnabled(): boolean {
	return settingsStore.readSettings()?.agy?.enabled === true;
}

export function agyAvailable(): boolean {
	return agyEnabled() && getAgyBinary() !== null;
}
