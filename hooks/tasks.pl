#!/usr/bin/perl
# live-sessions: the background work a Claude Code session has going, read from its transcript: what it started (a
# command run in the background, or moved there when it ran past its time; a monitor; an agent) that no record says has
# ended. Only ids, times, kinds and what each call said it does (its description, cut short) leave it.
#
#   tasks.pl SINCE FILE [SINCE FILE]...
#     For each file: `==> FILE`, then a line for each task started at or after SINCE (ms since the epoch: when the
#     session's process started, which ends every task it had before), oldest first:
#       T \t KIND \t ID \t STARTED_MS \t ENDS_BY_MS \t WHAT
#     KIND is `shell`, `monitor` or `agent`. ENDS_BY_MS is when a monitor that is not persistent expires (its start and
#     its timeout), '' for the rest. WHAT is the call's description, its white space made single spaces, at most 120
#     characters; '' without one. A task ends at its notification with any status but `running` (completed, failed,
#     killed, stopped), a monitor too at the notice of its expiry (an event `[Monitor expired …]` or `[Monitor timed
#     out …]`, with no status), and any when TaskStop stopped it. A notification counts only as Claude Code queues or
#     hands it on (a string that starts with it: a queued operation's content, a queued command's prompt, a prompt's
#     text), never as quoted in a tool's output or an agent's reply. Records of a subagent's own (sidechain) are not the
#     session's.
use strict;
use warnings;
use JSON::PP;
use Time::Local qw(timegm);

binmode STDOUT, ':encoding(UTF-8)';
my $json = JSON::PP->new->utf8;

while (@ARGV >= 2) {
  my ($since, $file) = splice @ARGV, 0, 2;
  tasks($since =~ /^\d+$/ ? $since : 0, $file);
}
exit 0;

# a record's ISO time (UTC, `2026-10-12T21:38:01.837Z`) in ms since the epoch; undef for anything else
sub ms {
  my ($iso) = @_;
  return undef unless defined $iso && !ref $iso;
  my ($y, $mo, $d, $h, $mi, $s, $frac) = $iso =~ /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z$/ or return undef;
  my $at = eval { timegm($s, $mi, $h, $d, $mo - 1, $y) };
  return undef unless defined $at;
  return $at * 1000 + int(substr(($frac // '') . '000', 0, 3));
}

sub text { my ($v) = @_; return defined $v && !ref $v ? $v : undef }

# a call's description as one short line
sub said {
  my ($v) = @_;
  my $s = text($v) // '';
  $s =~ s/[\x00-\x1f\x7f-\x9f\s]+/ /g;
  $s =~ s/^ | $//g;
  return length $s > 120 ? substr($s, 0, 119) . "\x{2026}" : $s;
}

# the tool call a result answers: its tool_result's `tool_use_id`
sub use_of {
  my ($r) = @_;
  my $content = ref $r->{message} eq 'HASH' ? $r->{message}{content} : undef;
  return undef unless ref $content eq 'ARRAY';
  for my $block (@$content) {
    return text($block->{tool_use_id}) if ref $block eq 'HASH' && ($block->{type} // '') eq 'tool_result';
  }
  return undef;
}

sub tasks {
  my ($since, $file) = @_;
  print "==> $file\n";
  open(my $fh, '<:raw', $file) or return;
  my (%task, %ended);
  while (my $line = <$fh>) {
    my $isNotice = index($line, '<task-notification>') >= 0;
    my $isResult = index($line, '"toolUseResult":{') >= 0 &&
      (index($line, '"backgroundTaskId":"') >= 0 || index($line, '"agentId":"') >= 0 || index($line, '"taskId":"') >= 0 || index($line, '"task_id":"') >= 0);
    next unless $isNotice || $isResult;
    # (a key and value written as such, unescaped, are the record's own: inside any text they are escaped)
    next if index($line, '"isSidechain":true') >= 0;
    # a notification as Claude Code queues or hands it on, read from the line as it is (records holding them can be
    # large, and only its tags are wanted): a string value that starts with it; one an agent wrote out in its reply, or
    # a tool's output that quotes one, is not one
    if ($isNotice && index($line, '"type":"assistant"') < 0) {
      while ($line =~ /"(?:content|prompt|text)":"(<task-notification>(?:[^"\\]|\\.)*)"/g) {
        my $carried = $1;
        while ($carried =~ /<task-notification>(.*?)<\/task-notification>/g) {
          my $body = $1;
          my ($id) = $body =~ /<task-id>([^<]+)<\/task-id>/;
          my ($status) = $body =~ /<status>([A-Za-z_]+)<\/status>/;
          my $isExpired = $body =~ /<event>\[Monitor (?:expired|timed out)\b/;
          $ended{$id} = 1 if defined $id && ((defined $status && $status ne 'running') || $isExpired);
        }
      }
    }
    next unless $isResult;
    my $r = eval { $json->decode($line) };
    next unless ref $r eq 'HASH' && !$r->{isSidechain} && (text($r->{type}) // '') eq 'user' && ref $r->{toolUseResult} eq 'HASH';
    my $u = $r->{toolUseResult};
    if (defined text($u->{task_id}) && (text($u->{message}) // '') =~ /^Successfully stopped task/) {
      $ended{$u->{task_id}} = 1;
      next;
    }
    my ($kind, $id, $what, $timeout);
    if (defined text($u->{backgroundTaskId})) {
      ($kind, $id) = ('shell', $u->{backgroundTaskId});
    } elsif ($u->{isAsync} && (text($u->{status}) // '') eq 'async_launched' && defined text($u->{agentId})) {
      ($kind, $id, $what) = ('agent', $u->{agentId}, said($u->{description}));
    } elsif (defined text($u->{taskId}) && exists $u->{timeoutMs}) {
      ($kind, $id) = ('monitor', $u->{taskId});
      # one that is not persistent expires at its timeout
      $timeout = $u->{timeoutMs} if !$u->{persistent} && defined text($u->{timeoutMs}) && $u->{timeoutMs} =~ /^\d+$/;
    } else {
      next;
    }
    my $at = ms($r->{timestamp});
    next unless defined $at && $at >= $since && !exists $task{$id};
    $task{$id} = { kind => $kind, at => $at, what => $what, use => use_of($r), ends => defined $timeout ? $at + $timeout : '' };
  }
  my @open = sort { $task{$a}{at} <=> $task{$b}{at} || $a cmp $b } grep { !$ended{$_} } keys %task;
  # what each still-open shell or monitor call said it does, from the call itself
  my %wanted = map { $task{$_}{use} => $_ } grep { !defined $task{$_}{what} && defined $task{$_}{use} } @open;
  if (%wanted && seek($fh, 0, 0)) {
    while (my $line = <$fh>) {
      next unless index($line, '"type":"tool_use"') >= 0;
      my @here = grep { index($line, "\"id\":\"$_\"") >= 0 } keys %wanted;
      next unless @here;
      my $r = eval { $json->decode($line) };
      my $content = ref $r eq 'HASH' && ref $r->{message} eq 'HASH' ? $r->{message}{content} : undef;
      next unless ref $content eq 'ARRAY';
      for my $block (@$content) {
        next unless ref $block eq 'HASH' && ($block->{type} // '') eq 'tool_use' && defined text($block->{id});
        my $id = delete $wanted{$block->{id}};
        $task{$id}{what} = said(ref $block->{input} eq 'HASH' ? $block->{input}{description} : undef) if defined $id;
      }
      last unless %wanted;
    }
  }
  close $fh;
  for my $id (@open) {
    my $t = $task{$id};
    (my $shown = $id) =~ s/[\t\n\r]/ /g;
    print join("\t", 'T', $t->{kind}, $shown, $t->{at}, $t->{ends}, $t->{what} // ''), "\n";
  }
}
