export interface NavItem {
  href: string;
  label: string;
  /** Lucide icon name — rendered in AppSidebar via the ICON_MAP */
  icon: string;
  description: string;
  /** Group heading this item belongs to, for sidebar sectioning. */
  group: "Operación" | "Administración" | "Cliente";
}

/**
 * Single source of truth for the dashboard's primary navigation, shared by
 * the sidebar shell and the home page's quick-launch grid.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard",      label: "Dashboard",        icon: "LayoutDashboard", description: "Costos diarios por proveedor",                          group: "Operación"      },
  { href: "/calls",          label: "Llamadas",          icon: "Phone",           description: "Llamadas entrantes y salientes",                        group: "Operación"      },
  { href: "/campaigns",      label: "Campañas",          icon: "Megaphone",       description: "Marcador masivo: sube CSV y llama en masa",             group: "Operación"      },
  { href: "/sessions",       label: "Sesiones",          icon: "Activity",        description: "Sesiones de voz y desglose de costos",                  group: "Operación"      },
  { href: "/agent",          label: "Hablar con agente", icon: "Mic",             description: "Abrir la interfaz de voz",                              group: "Operación"      },
  { href: "/admin/clients",     label: "Clientes",          icon: "Users",           description: "Gestionar cuentas y asignaciones de clientes",          group: "Administración" },
  { href: "/admin/agents",      label: "Agentes",           icon: "Bot",             description: "Crear y gestionar agentes de voz",                      group: "Administración" },
  { href: "/admin/tools",       label: "Herramientas",      icon: "Wrench",          description: "Catálogo global de webhooks reutilizables",              group: "Administración" },
  { href: "/admin/sip-trunks",  label: "SIP Trunks (BYOC)", icon: "Network",         description: "Números propios de clientes vía carrier externo",        group: "Administración" },
  { href: "/admin/phone-numbers", label: "Números Telefónicos", icon: "PhoneCall",    description: "Catálogo de números (Twilio u otros)",                  group: "Administración" },
  { href: "/admin/users",       label: "Usuarios",          icon: "UserCog",         description: "Invitar usuarios y asignar roles",                      group: "Administración" },
  { href: "/settings",          label: "Configuración",     icon: "Settings",        description: "Modelos y voces",                                       group: "Administración" },
  { href: "/portal",         label: "Portal Clientes",   icon: "MonitorSmartphone", description: "Vista del cliente: campañas y transcripts",           group: "Cliente"        },
];

export const NAV_GROUPS: NavItem["group"][] = ["Operación", "Administración", "Cliente"];
