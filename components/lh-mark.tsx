/**
 * LhMark — the app mark (owner's icon-no-padding.svg, 2026-09-17), inlined
 * as JSX so it rides along with the components (no network fetch, recolorable,
 * crisp at any size). 806×806 viewBox, no padding: sizing/padding is the
 * consumer's job. The gray path is the harness spiral; the ring is the
 * mark's own stroke in the strong line ink (white in dark, the foreground
 * in light).
 *
 * Replaces the "LH" wordmark text in the sidebar band (also the traffic-light
 * gutter's resident in the merged desktop chrome).
 */
export function LhMark({ className = "" }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 806 806"
			className={className}
			style={{ fillRule: "evenodd", clipRule: "evenodd", strokeLinejoin: "round", strokeMiterlimit: 2 }}
			aria-hidden="true"
		>
			<g transform="matrix(1,0,0,1,-109.002299,-109.002299)">
				<g transform="matrix(0.939904,0,0,0.939904,30.769428,30.766742)">
					<g transform="matrix(-0.232199,0,0,0.232199,1384.403797,-416.791824)">
						<g transform="matrix(0.573992,-2.142166,2.142166,0.573992,-5516.07298,4432.117471)">
							<path
								d="M1234.728,3305.937C871.642,3324.965 587,3624.915 587,3988.5C587,4365.734 893.266,4672 1270.5,4672C1647.734,4672 1954,4365.734 1954,3988.5C1954,3880.637 1928.472,3774.304 1879.503,3678.197L1794.243,3721.64C1836.356,3804.292 1858.31,3895.737 1858.31,3988.5C1858.31,4312.921 1594.921,4576.31 1270.5,4576.31C946.079,4576.31 682.69,4312.921 682.69,3988.5C682.69,3675.817 927.482,3417.86 1239.736,3401.496L1234.728,3305.937Z"
								style={{ fill: "rgb(148,148,148)" }}
							/>
						</g>
						<g transform="matrix(1.261034,-0,-0,1.261034,1170.373407,-2014.261188)">
							<path
								d="M1270.5,3305C893.266,3305 587,3611.266 587,3988.5C587,4365.734 893.266,4672 1270.5,4672C1647.734,4672 1954,4365.734 1954,3988.5C1954,3611.266 1647.734,3305 1270.5,3305ZM1270.5,3471.537C1555.819,3471.537 1787.463,3703.181 1787.463,3988.5C1787.463,4273.819 1555.819,4505.463 1270.5,4505.463C985.181,4505.463 753.537,4273.819 753.537,3988.5C753.537,3703.181 985.181,3471.537 1270.5,3471.537Z"
								style={{ fill: "var(--lh-line-strong)" }}
							/>
						</g>
						<g transform="matrix(1.261034,0,-0,1.261034,3139.627182,-45.007413)">
							<circle cx="1270.5" cy="3988.5" r="683.5" style={{ fill: "var(--lh-line-strong)" }} />
						</g>
					</g>
				</g>
			</g>
		</svg>
	);
}
