/*
 * Small C entry point around libklscte35, for the WebAssembly build.
 *
 * The library has no JSON output of its own unless json-c is present, and
 * json-c would drag a second copy of the filesystem into the module. So this
 * shim unpacks a splice_info_section and prints a compact JSON line with the
 * fields the inspector compares against its own parse.
 *
 * kl_parse() takes a pointer into the WebAssembly heap and returns a pointer
 * to a static buffer. The JavaScript side copies the string out immediately.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <libklscte35/scte35.h>

#define SHIM_BUFFER 8192

static char out[SHIM_BUFFER];

static void put_hex(char *dst, size_t cap, const uint8_t *src, unsigned len)
{
	static const char *digits = "0123456789abcdef";
	size_t used = 0;
	for (unsigned i = 0; i < len && used + 2 < cap; i++) {
		dst[used++] = digits[(src[i] >> 4) & 0xF];
		dst[used++] = digits[src[i] & 0xF];
	}
	dst[used] = 0;
}

static void put_json_string(char *dst, size_t cap, const char *src, size_t len)
{
	size_t used = 0;
	if (cap < 3) return;
	dst[used++] = '"';
	for (size_t i = 0; i < len && used + 3 < cap; i++) {
		unsigned char c = (unsigned char)src[i];
		if (c == '"' || c == '\\') {
			dst[used++] = '\\';
			dst[used++] = (char)c;
		} else if (c < 0x20) {
			used += (size_t)snprintf(dst + used, cap - used, "\\u%04x", c);
		} else {
			dst[used++] = (char)c;
		}
	}
	dst[used++] = '"';
	dst[used] = 0;
}

const char *kl_parse(const uint8_t *src, uint32_t len)
{
	struct scte35_splice_info_section_s *si = NULL;
	ssize_t used;

	out[0] = 0;
	if (!src || len < 3) {
		snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"short section\"}");
		return out;
	}

	si = scte35_splice_info_section_alloc(SCTE35_COMMAND_TYPE__SPLICE_NULL);
	if (!si) {
		snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"out of memory\"}");
		return out;
	}

	used = scte35_splice_info_section_unpackFrom(si, src, len);
	if (used < 0) {
		scte35_splice_info_section_free(si);
		snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"unpack %d\"}", (int)used);
		return out;
	}

	char upid[520];
	int at = 0;
	at += snprintf(out + at, sizeof(out) - (size_t)at,
		"{\"ok\":true,\"command\":\"0x%02x\",\"protocolVersion\":%u,"
		"\"encrypted\":%s,\"ptsAdjustment\":%llu,\"tier\":%u,"
		"\"commandLength\":%u,\"descriptorCount\":%u,\"crcOk\":%s,",
		si->splice_command_type, si->protocol_version,
		si->encrypted_packet ? "true" : "false",
		(unsigned long long)si->pts_adjustment, si->tier,
		si->splice_command_length, si->descriptor_loop_count,
		si->crc_32_is_valid ? "true" : "false");

	if (si->splice_command_type == SCTE35_COMMAND_TYPE__SPLICE_INSERT) {
		struct scte35_splice_insert_s *in = &si->splice_insert;
		at += snprintf(out + at, sizeof(out) - (size_t)at,
			"\"spliceEventId\":%u,\"cancel\":%s,\"outOfNetwork\":%s,"
			"\"duration\":%s,\"breakDuration\":%llu,\"autoReturn\":%s,"
			"\"uniqueProgramId\":%u,\"availNum\":%u,\"availsExpected\":%u,",
			in->splice_event_id,
			in->splice_event_cancel_indicator ? "true" : "false",
			in->out_of_network_indicator ? "true" : "false",
			in->duration_flag ? "true" : "false",
			(unsigned long long)(in->duration_flag ? in->duration.duration : 0),
			in->duration.auto_return ? "true" : "false",
			in->unique_program_id, in->avail_num, in->avails_expected);
	}

	at += snprintf(out + at, sizeof(out) - (size_t)at, "\"segmentation\":[");
	int first = 1;
	for (int i = 0; i < si->descriptor_loop_count && i < SCTE35_MAX_DESCRIPTORS; i++) {
		struct splice_descriptor *d = si->descriptors[i];
		if (!d || d->splice_descriptor_tag != SCTE35_SEGMENTATION_DESCRIPTOR) continue;
		struct splice_descriptor_segmentation *sg = &d->seg_data;
		put_hex(upid, sizeof(upid), sg->upid, sg->upid_length);
		at += snprintf(out + at, sizeof(out) - (size_t)at,
			"%s{\"eventId\":%u,\"typeId\":%u,\"upidType\":%u,\"upid\":\"%s\","
			"\"duration\":%llu,\"segmentNum\":%u,\"segmentsExpected\":%u}",
			first ? "" : ",",
			sg->event_id, sg->type_id, sg->upid_type, upid,
			(unsigned long long)(sg->segmentation_duration_flag ? sg->segmentation_duration : 0),
			sg->segment_num, sg->segments_expected);
		first = 0;
	}
	at += snprintf(out + at, sizeof(out) - (size_t)at, "]}");

	scte35_splice_info_section_free(si);
	return out;
}
