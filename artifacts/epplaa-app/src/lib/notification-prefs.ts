export interface NotificationPrefs {
  liveDrops: boolean;
  orderUpdates: boolean;
  marketing: boolean;
  whatsapp: boolean;
  sms: boolean;
  whatsappNumber?: string;
  smsNumber?: string;
}

export const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  liveDrops: true,
  orderUpdates: true,
  marketing: false,
  whatsapp: true,
  sms: false,
  whatsappNumber: "",
  smsNumber: "",
};
