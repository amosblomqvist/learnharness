export interface MobileAccessStatus {
	available: boolean;
	enabled: boolean;
	remote: boolean;
	serving?: boolean;
	url?: string | null;
	/** DNS-independent http://<tailnet IPv4>:<port> link, when configured. */
	directUrl?: string | null;
	message: string;
	setupCommand?: string;
	directSetupCommand?: string;
	transport?: "desktop" | "web";
}
export interface MobileAccessBridge {
	status(): Promise<MobileAccessStatus>;
	refresh(): Promise<MobileAccessStatus>;
	enable(enabled: boolean): Promise<MobileAccessStatus>;
	preview(size: string): Promise<MobileAccessStatus>;
}
