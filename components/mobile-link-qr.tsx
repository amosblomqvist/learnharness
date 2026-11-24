"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** The link as a QR code SVG: black modules on a white tile with a quiet zone,
 * so a phone camera reads it in dark mode too. */
export function mobileLinkQrSvg(link: string): Promise<string> {
	return QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
}

/** A scannable QR code that opens `link` on the phone. */
export function MobileLinkQr({ link, size = 160, testid }: { link: string; size?: number; testid?: string }) {
	const [svg, setSvg] = useState<{ link: string; markup: string } | null>(null);
	useEffect(() => {
		let live = true;
		void mobileLinkQrSvg(link).then(markup => { if (live) setSvg({ link, markup }); }).catch(() => { if (live) setSvg(null); });
		return () => { live = false; };
	}, [link]);
	const markup = svg?.link === link ? svg.markup : null;
	return (
		<div
			role="img"
			aria-label={`QR code for ${link}`}
			data-testid={testid}
			className="shrink-0 overflow-hidden rounded-md bg-white [&>svg]:block [&>svg]:size-full"
			style={{ width: size, height: size }}
			// The SVG comes from the qrcode encoder, not from user markup.
			dangerouslySetInnerHTML={markup ? { __html: markup } : undefined}
		/>
	);
}
