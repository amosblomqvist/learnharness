import type { DetailedHTMLProps, HTMLAttributes } from "react";

type MediaChromeElementProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
	audio?: boolean;
	hotkeys?: string;
	nohotkeys?: boolean;
	"show-duration"?: boolean;
	rates?: string;
	slot?: string;
};

declare module "react" {
	namespace JSX {
		interface IntrinsicElements {
			"media-controller": MediaChromeElementProps;
			"media-control-bar": MediaChromeElementProps;
			"media-play-button": MediaChromeElementProps;
			"media-time-range": MediaChromeElementProps;
			"media-time-display": MediaChromeElementProps;
			"media-mute-button": MediaChromeElementProps;
			"media-volume-range": MediaChromeElementProps;
			"media-playback-rate-button": MediaChromeElementProps;
			"media-fullscreen-button": MediaChromeElementProps;
		}
	}
}
