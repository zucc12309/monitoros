//! DSU ("Cemuhook") wire format, server side.
//!
//! Layouts match Dolphin's client (`InputCommon/ControllerInterface/
//! DualShockUDPClient/DualShockUDPProto.h`, verified against 2609a):
//! little-endian, packed, a 16-byte header, then a u32 message type. The
//! CRC32 covers the whole packet with the CRC field zeroed.
//!
//! Dolphin reads face buttons, D-pad, shoulders and triggers from the
//! *analog* pressure bytes (0 or 255), and L3/R3/Share/Options from the bit
//! fields, so both are filled in.

pub const PROTOCOL_VERSION: u16 = 1001;
pub const SLOT_COUNT: usize = 4;
pub const HEADER_LEN: usize = 16;

pub const MSG_VERSION: u32 = 0x10_0000;
pub const MSG_PORTS: u32 = 0x10_0001;
pub const MSG_DATA: u32 = 0x10_0002;

pub const VERSION_RESPONSE_LEN: usize = 24;
pub const PORT_INFO_LEN: usize = 32;
pub const PAD_DATA_LEN: usize = 100;
/// Largest client request (PadDataRequest = 16 + 4 + 1 + 1 + 6).
pub const MAX_CLIENT_PACKET: usize = 28;

/// Buttons, as a bit set. Names follow the DualShock layout DSU uses.
pub mod button {
    pub const DPAD_UP: u32 = 1 << 0;
    pub const DPAD_DOWN: u32 = 1 << 1;
    pub const DPAD_LEFT: u32 = 1 << 2;
    pub const DPAD_RIGHT: u32 = 1 << 3;
    pub const CROSS: u32 = 1 << 4;
    pub const CIRCLE: u32 = 1 << 5;
    pub const SQUARE: u32 = 1 << 6;
    pub const TRIANGLE: u32 = 1 << 7;
    pub const L1: u32 = 1 << 8;
    pub const R1: u32 = 1 << 9;
    pub const L2: u32 = 1 << 10;
    pub const R2: u32 = 1 << 11;
    pub const SHARE: u32 = 1 << 12;
    pub const OPTIONS: u32 = 1 << 13;
    pub const L3: u32 = 1 << 14;
    pub const R3: u32 = 1 << 15;
    pub const PS: u32 = 1 << 16;
    pub const TOUCH: u32 = 1 << 17;
    pub const ALL: u32 = (1 << 18) - 1;
}

/// One controller's full state. Every update is a complete snapshot, so a
/// lost or coalesced packet can never leave a button stuck down.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PadState {
    pub buttons: u32,
    /// Sticks in -1.0..=1.0; +y = up.
    pub left: (f32, f32),
    pub right: (f32, f32),
    /// Accelerometer in g, gyro in degrees/second (phone tilt steering).
    pub accel: (f32, f32, f32),
    pub gyro: (f32, f32, f32),
}

impl PadState {
    /// All buttons released, sticks centred, device lying flat.
    pub fn neutral() -> Self {
        PadState { accel: (0.0, -1.0, 0.0), ..Default::default() }
    }

    /// Clamp everything into range and drop non-finite values.
    pub fn sanitized(mut self) -> Self {
        let c = |v: f32, lim: f32| if v.is_finite() { v.clamp(-lim, lim) } else { 0.0 };
        self.buttons &= button::ALL;
        self.left = (c(self.left.0, 1.0), c(self.left.1, 1.0));
        self.right = (c(self.right.0, 1.0), c(self.right.1, 1.0));
        self.accel = (c(self.accel.0, 8.0), c(self.accel.1, 8.0), c(self.accel.2, 8.0));
        self.gyro = (c(self.gyro.0, 2000.0), c(self.gyro.1, 2000.0), c(self.gyro.2, 2000.0));
        self
    }
}

fn stick(v: f32) -> u8 {
    // -1 → 0, 0 → 128, +1 → 255
    let v = if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 };
    let scale = if v < 0.0 { 128.0 } else { 127.0 };
    (128.0 + v * scale).round() as u8
}

fn header(buf: &mut [u8], server_id: u32, msg_type: u32) {
    buf[0..4].copy_from_slice(b"DSUS");
    buf[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    let len = (buf.len() - HEADER_LEN) as u16;
    buf[6..8].copy_from_slice(&len.to_le_bytes());
    // 8..12 CRC, filled by finish()
    buf[12..16].copy_from_slice(&server_id.to_le_bytes());
    buf[16..20].copy_from_slice(&msg_type.to_le_bytes());
}

fn finish(buf: &mut [u8]) {
    buf[8..12].fill(0);
    let crc = crc32fast::hash(buf);
    buf[8..12].copy_from_slice(&crc.to_le_bytes());
}

/// Fake but stable per-slot MAC (DSU identifies pads by MAC).
pub fn slot_mac(slot: u8) -> [u8; 6] {
    [0x4D, 0x4F, 0x53, 0x00, 0x00, slot + 1] // "MOS"
}

/// Shared 11-byte pad description used by PortInfo and PadData.
fn pad_meta(buf: &mut [u8], slot: u8, connected: bool) {
    buf[0] = slot;
    buf[1] = if connected { 0x02 } else { 0x00 }; // DsState
    buf[2] = if connected { 0x02 } else { 0x00 }; // DsModel::FullGyro
    buf[3] = if connected { 0x02 } else { 0x00 }; // DsConnection::Bluetooth
    buf[4..10].copy_from_slice(&if connected { slot_mac(slot) } else { [0; 6] });
    buf[10] = if connected { 0x05 } else { 0x00 }; // DsBattery::Full
}

pub fn version_response(server_id: u32) -> [u8; VERSION_RESPONSE_LEN] {
    let mut b = [0u8; VERSION_RESPONSE_LEN];
    header(&mut b, server_id, MSG_VERSION);
    b[20..22].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    finish(&mut b);
    b
}

pub fn port_info(server_id: u32, slot: u8, connected: bool) -> [u8; PORT_INFO_LEN] {
    let mut b = [0u8; PORT_INFO_LEN];
    header(&mut b, server_id, MSG_PORTS);
    pad_meta(&mut b[20..31], slot, connected);
    finish(&mut b);
    b
}

pub fn pad_data(server_id: u32, slot: u8, connected: bool, counter: u32, timestamp_us: u64, s: &PadState) -> [u8; PAD_DATA_LEN] {
    use button::*;
    let mut b = [0u8; PAD_DATA_LEN];
    header(&mut b, server_id, MSG_DATA);
    pad_meta(&mut b[20..31], slot, connected);
    b[31] = connected as u8; // active
    b[32..36].copy_from_slice(&counter.to_le_bytes());
    let on = |m: u32| s.buttons & m != 0;
    let bit = |m: u32, v: u8| if on(m) { v } else { 0 };
    // button_states1: Left 0x80 Down 0x40 Right 0x20 Up 0x10 Options 0x08 R3 0x04 L3 0x02 Share 0x01
    b[36] = bit(DPAD_LEFT, 0x80) | bit(DPAD_DOWN, 0x40) | bit(DPAD_RIGHT, 0x20) | bit(DPAD_UP, 0x10) | bit(OPTIONS, 0x08) | bit(R3, 0x04) | bit(L3, 0x02) | bit(SHARE, 0x01);
    // button_states2: Square 0x80 Cross 0x40 Circle 0x20 Triangle 0x10 R1 0x08 L1 0x04 R2 0x02 L2 0x01
    b[37] = bit(SQUARE, 0x80) | bit(CROSS, 0x40) | bit(CIRCLE, 0x20) | bit(TRIANGLE, 0x10) | bit(R1, 0x08) | bit(L1, 0x04) | bit(R2, 0x02) | bit(L2, 0x01);
    b[38] = bit(PS, 1);
    b[39] = bit(TOUCH, 1);
    b[40] = stick(s.left.0);
    b[41] = stick(s.left.1);
    b[42] = stick(s.right.0);
    b[43] = stick(s.right.1);
    let analog = |m: u32| if on(m) { 255 } else { 0 };
    // D-pad W S E N, then Square Cross Circle Triangle, R1 L1, R2 L2
    for (i, m) in [DPAD_LEFT, DPAD_DOWN, DPAD_RIGHT, DPAD_UP, SQUARE, CROSS, CIRCLE, TRIANGLE, R1, L1, R2, L2].into_iter().enumerate() {
        b[44 + i] = analog(m);
    }
    // 56..68: two touch points, unused (inactive)
    b[68..76].copy_from_slice(&timestamp_us.to_le_bytes());
    for (i, v) in [s.accel.0, s.accel.1, s.accel.2, s.gyro.0, s.gyro.1, s.gyro.2].into_iter().enumerate() {
        b[76 + i * 4..80 + i * 4].copy_from_slice(&v.to_le_bytes());
    }
    finish(&mut b);
    b
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClientRequest {
    Version,
    /// Which slots the client asked about (validated to 0..4).
    ListPorts(Vec<u8>),
    /// Subscribe to pad data.
    PadData(Subscription),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Subscription {
    All,
    Slot(u8),
    Mac([u8; 6]),
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    TooShort,
    TooLong,
    BadMagic,
    BadVersion,
    BadLength,
    BadCrc,
    UnknownType,
    BadField,
}

/// Validates a client packet the same way Dolphin validates server packets.
pub fn parse_client(packet: &[u8]) -> Result<ClientRequest, ParseError> {
    if packet.len() > MAX_CLIENT_PACKET {
        return Err(ParseError::TooLong);
    }
    if packet.len() < HEADER_LEN + 4 {
        return Err(ParseError::TooShort);
    }
    if &packet[0..4] != b"DSUC" {
        return Err(ParseError::BadMagic);
    }
    let version = u16::from_le_bytes([packet[4], packet[5]]);
    if version > PROTOCOL_VERSION {
        return Err(ParseError::BadVersion);
    }
    let len = u16::from_le_bytes([packet[6], packet[7]]) as usize;
    if HEADER_LEN + len != packet.len() {
        return Err(ParseError::BadLength);
    }
    let crc = u32::from_le_bytes(packet[8..12].try_into().unwrap());
    let mut copy = [0u8; MAX_CLIENT_PACKET];
    copy[..packet.len()].copy_from_slice(packet);
    copy[8..12].fill(0);
    if crc32fast::hash(&copy[..packet.len()]) != crc {
        return Err(ParseError::BadCrc);
    }
    let body = &packet[HEADER_LEN + 4..];
    match u32::from_le_bytes(packet[16..20].try_into().unwrap()) {
        MSG_VERSION => Ok(ClientRequest::Version),
        MSG_PORTS => {
            if body.len() < 4 {
                return Err(ParseError::BadField);
            }
            let count = i32::from_le_bytes(body[0..4].try_into().unwrap());
            if !(0..=SLOT_COUNT as i32).contains(&count) || body.len() < 4 + count as usize {
                return Err(ParseError::BadField);
            }
            let slots = body[4..4 + count as usize].iter().copied().filter(|&s| (s as usize) < SLOT_COUNT).collect();
            Ok(ClientRequest::ListPorts(slots))
        }
        MSG_DATA => {
            if body.len() < 8 {
                return Err(ParseError::BadField);
            }
            Ok(ClientRequest::PadData(match body[0] {
                0 => Subscription::All,
                1 if (body[1] as usize) < SLOT_COUNT => Subscription::Slot(body[1]),
                2 => Subscription::Mac(body[2..8].try_into().unwrap()),
                _ => return Err(ParseError::BadField),
            }))
        }
        _ => Err(ParseError::UnknownType),
    }
}

/// Builds a client packet (used by tests and the CI fake Dolphin).
pub fn client_packet(msg_type: u32, body: &[u8]) -> Vec<u8> {
    let mut b = vec![0u8; HEADER_LEN + 4 + body.len()];
    b[0..4].copy_from_slice(b"DSUC");
    b[4..6].copy_from_slice(&PROTOCOL_VERSION.to_le_bytes());
    let len = (b.len() - HEADER_LEN) as u16;
    b[6..8].copy_from_slice(&len.to_le_bytes());
    b[12..16].copy_from_slice(&0x00C1_1E17u32.to_le_bytes());
    b[16..20].copy_from_slice(&msg_type.to_le_bytes());
    b[20..].copy_from_slice(body);
    finish(&mut b);
    b
}

/// Decoded server pad packet (tests / fake Dolphin).
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedPad {
    pub slot: u8,
    pub connected: bool,
    pub counter: u32,
    pub states1: u8,
    pub states2: u8,
    pub left: (u8, u8),
    pub analog: [u8; 12],
    pub accel: (f32, f32, f32),
}

pub fn decode_pad_data(b: &[u8]) -> Option<DecodedPad> {
    if b.len() != PAD_DATA_LEN || &b[0..4] != b"DSUS" || u32::from_le_bytes(b[16..20].try_into().ok()?) != MSG_DATA {
        return None;
    }
    let mut copy = b.to_vec();
    let crc = u32::from_le_bytes(copy[8..12].try_into().ok()?);
    copy[8..12].fill(0);
    if crc32fast::hash(&copy) != crc {
        return None;
    }
    let f = |i: usize| f32::from_le_bytes(b[i..i + 4].try_into().unwrap());
    Some(DecodedPad {
        slot: b[20],
        connected: b[21] == 0x02,
        counter: u32::from_le_bytes(b[32..36].try_into().ok()?),
        states1: b[36],
        states2: b[37],
        left: (b[40], b[41]),
        analog: b[44..56].try_into().ok()?,
        accel: (f(76), f(80), f(84)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packet_sizes_match_dolphin_structs() {
        assert_eq!(version_response(1).len(), 24);
        assert_eq!(port_info(1, 0, true).len(), 32);
        assert_eq!(pad_data(1, 0, true, 0, 0, &PadState::neutral()).len(), 100);
        // message_length excludes the 16-byte header
        assert_eq!(u16::from_le_bytes([pad_data(1, 0, true, 0, 0, &PadState::neutral())[6], 0]), 84);
    }

    #[test]
    fn crc_covers_the_whole_packet() {
        let mut p = pad_data(7, 2, true, 5, 9, &PadState { buttons: button::CROSS, ..PadState::neutral() });
        assert!(decode_pad_data(&p).is_some());
        p[60] ^= 1; // any byte change breaks the CRC
        assert!(decode_pad_data(&p).is_none());
    }

    #[test]
    fn buttons_fill_both_bits_and_analog_pressure() {
        let s = PadState { buttons: button::CROSS | button::DPAD_LEFT | button::R2 | button::OPTIONS, ..PadState::neutral() };
        let d = decode_pad_data(&pad_data(1, 1, true, 3, 0, &s)).unwrap();
        assert_eq!(d.states1, 0x80 | 0x08); // Left + Options
        assert_eq!(d.states2, 0x40 | 0x02); // Cross + R2
        // analog order: W S E N Square Cross Circle Triangle R1 L1 R2 L2
        assert_eq!(d.analog, [255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0]);
    }

    #[test]
    fn sticks_map_to_dsu_bytes() {
        assert_eq!(stick(-1.0), 0);
        assert_eq!(stick(0.0), 128);
        assert_eq!(stick(1.0), 255);
        assert_eq!(stick(f32::NAN.max(-5.0)), 0);
    }

    #[test]
    fn sanitize_clamps_and_masks() {
        let s = PadState { buttons: u32::MAX, left: (f32::INFINITY, -3.0), gyro: (1e9, f32::NAN, 0.0), ..Default::default() }.sanitized();
        assert_eq!(s.buttons, button::ALL);
        assert_eq!(s.left, (0.0, -1.0));
        assert_eq!(s.gyro, (2000.0, 0.0, 0.0));
    }

    #[test]
    fn parses_valid_client_requests() {
        assert_eq!(parse_client(&client_packet(MSG_VERSION, &[])), Ok(ClientRequest::Version));
        let ports = client_packet(MSG_PORTS, &[4, 0, 0, 0, 0, 1, 2, 3]);
        assert_eq!(parse_client(&ports), Ok(ClientRequest::ListPorts(vec![0, 1, 2, 3])));
        let all = client_packet(MSG_DATA, &[0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(parse_client(&all), Ok(ClientRequest::PadData(Subscription::All)));
        let one = client_packet(MSG_DATA, &[1, 3, 0, 0, 0, 0, 0, 0]);
        assert_eq!(parse_client(&one), Ok(ClientRequest::PadData(Subscription::Slot(3))));
    }

    #[test]
    fn rejects_malformed_or_hostile_packets() {
        let good = client_packet(MSG_VERSION, &[]);
        let mut bad_crc = good.clone();
        bad_crc[12] ^= 1;
        assert_eq!(parse_client(&bad_crc), Err(ParseError::BadCrc));
        let mut server_magic = good.clone();
        server_magic[0..4].copy_from_slice(b"DSUS");
        assert_eq!(parse_client(&server_magic), Err(ParseError::BadMagic));
        assert_eq!(parse_client(&good[..10]), Err(ParseError::TooShort));
        assert_eq!(parse_client(&[0u8; 2000]), Err(ParseError::TooLong));
        assert_eq!(parse_client(&client_packet(0xDEAD, &[])), Err(ParseError::UnknownType));
        assert_eq!(parse_client(&client_packet(MSG_PORTS, &[9, 0, 0, 0, 0])), Err(ParseError::BadField));
        assert_eq!(parse_client(&client_packet(MSG_DATA, &[1, 7, 0, 0, 0, 0, 0, 0])), Err(ParseError::BadField));
        let mut lying_len = good.clone();
        lying_len[6] = 200;
        assert_eq!(parse_client(&lying_len), Err(ParseError::BadLength));
    }
}
