{
  "name": "Omarchy",
  "mode": "{{ mode }}",
  "colors": {
    "background": "{{ background }}",
    "foreground": "{{ foreground }}",
    "card": "{{ mix background foreground 4% }}",
    "cardForeground": "{{ foreground }}",
    "popover": "{{ mix background foreground 4% }}",
    "popoverForeground": "{{ foreground }}",
    "primary": "{{ foreground }}",
    "primaryForeground": "{{ background }}",
    "secondary": "{{ mix background foreground 4% }}",
    "secondaryForeground": "{{ foreground }}",
    "muted": "{{ mix background foreground 4% }}",
    "mutedForeground": "{{ muted }}",
    "accent": "{{ mix background accent 25% }}",
    "accentForeground": "{{ foreground }}",
    "destructive": "{{ red }}",
    "border": "{{ mix background foreground 20% }}",
    "input": "{{ mix background foreground 20% }}",
    "ring": "{{ accent }}"
  }
}
