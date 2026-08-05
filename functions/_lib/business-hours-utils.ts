export interface BusinessHoursEntry {
  day: string
  openTime: string
  closeTime: string
  closed: boolean
}

function convertTo24Hour(time12h: string): string {
  const match = time12h.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (!match) return time12h.trim()
  const [, hours, minutes, period] = match
  let hour = parseInt(hours, 10)
  if (period.toUpperCase() === 'PM' && hour !== 12) hour += 12
  else if (period.toUpperCase() === 'AM' && hour === 12) hour = 0
  return `${hour.toString().padStart(2, '0')}:${minutes}`
}

export function convertGooglePlacesHoursToBusinessHours(
  weekdayText: string[],
): BusinessHoursEntry[] {
  const daysOfWeek = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  return daysOfWeek.map((day) => {
    const entry = weekdayText.find((text) => text.startsWith(day))
    if (!entry) return { day, openTime: '', closeTime: '', closed: true }
    if (/closed/i.test(entry)) return { day, openTime: '', closeTime: '', closed: true }
    const timeMatch = entry.match(/:\s*(.+?)\s*[–-]\s*(.+?)$/)
    if (!timeMatch) return { day, openTime: '', closeTime: '', closed: true }
    return {
      day,
      openTime: convertTo24Hour(timeMatch[1].trim()),
      closeTime: convertTo24Hour(timeMatch[2].trim()),
      closed: false,
    }
  })
}
