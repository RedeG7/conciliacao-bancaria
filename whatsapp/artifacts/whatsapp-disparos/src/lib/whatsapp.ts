export function generateWhatsAppLink(phone: string, message: string) {
  // Remove anything that is not a digit
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

export function parseMessage(template: string, contact: { name: string; phone: string; extraFields?: Record<string, string> }) {
  let msg = template;
  msg = msg.replace(/{nome}/gi, contact.name || '');
  msg = msg.replace(/{telefone}/gi, contact.phone || '');
  
  if (contact.extraFields) {
    for (const [key, value] of Object.entries(contact.extraFields)) {
      const regex = new RegExp(`{${key}}`, 'gi');
      msg = msg.replace(regex, value || '');
    }
  }
  return msg;
}
