#!/usr/bin/perl
# live-sessions: token counts read from Claude Code transcripts and Codex rollouts. Only numbers, times, model
# names, message ids and working directories leave it; nothing anyone wrote does.
#
#   usage.pl ctx FILE...
#     For each file: `==> FILE`, then `ctx TOKENS [WINDOW]`, the context of its last main-thread request as its last
#     256 KB record it (none if they do not).
#   usage.pl scan SINCE < (S \t REPLY_ID lines, then FILE \t OFFSET \t MARK lines)
#     For each file, from byte OFFSET to its last complete line: `==> FILE`, its sums, then `<== NEW_OFFSET \t MARK`
#     to pass back next time. A file now shorter than OFFSET is read again from its start.
#     Each sum is of one 10-minute slot (`2026-10-11T02:10`, UTC), at or after SINCE (ISO, UTC):
#     Claude transcript (any file not named rollout-*.jsonl): each reply counted once, by model and the folder it
#     worked in, even when a continued conversation copies it into another transcript (the S lines are replies
#     counted before; each one counted now is printed as `I \t REPLY_ID \t SLOT`). A reply is written over several
#     records, its output growing as it streams: what it read and wrote to the cache from its first, its output as
#     its last record has it (MARK: the last reply's id and the output counted for it, `ID,OUTPUT`).
#       C \t SLOT \t MODEL \t CWD \t INPUT \t CACHE_WRITE_5M \t CACHE_WRITE_1H \t CACHE_READ \t OUTPUT
#     Codex rollout: what each count adds to the conversation's running totals (MARK: those totals, `IN,CACHED,OUT`,
#     then a tab and the folder it works in), by folder; and its latest reading of each window of Codex's own limit
#     (`limit_id` codex; another model's limit is left out):
#       X \t SLOT \t CWD \t INPUT \t CACHED_INPUT \t OUTPUT
#       L \t TIME \t USED_PERCENT \t WINDOW_MINUTES \t RESETS_AT (epoch seconds)
#     CWD is as the record spells it (JSON string escapes kept).
use strict;
use warnings;

my $mode = shift @ARGV // '';
if ($mode eq 'ctx') {
  ctx($_) for @ARGV;
} elsif ($mode eq 'scan') {
  my $since = shift @ARGV // '';
  my %seen;
  while (my $line = <STDIN>) {
    chomp $line;
    if ($line =~ /^S\t(.+)$/) {
      $seen{$1} = 1;
      next;
    }
    my ($file, $offset, $mark) = split /\t/, $line, 3;
    next unless defined $file && $file ne '';
    scan($file, ($offset // '') =~ /^\d+$/ ? $offset : 0, $mark // '', $since, \%seen);
  }
} else {
  exit 2;
}
exit 0;

sub is_rollout { return $_[0] =~ m{/rollout-[^/]*\.jsonl$} }

# the last real (unescaped) occurrence of a key's string value, or its first after a position
sub last_string {
  my ($line, $key) = @_;
  my $value;
  while ($line =~ /(?<!\\)"\Q$key\E":"((?:[^"\\]|\\.)*)"/g) { $value = $1 }
  return $value;
}

# a Claude reply's usage: the message's own `usage`, the one that follows its `stop_sequence` (and `stop_details`), as
# the API writes a message; real JSON in a tool call's input, before it in the content or after it (a record's
# `wireToolInputs`), is never taken for it. Its fields are the first after it (its own, before any `iterations`).
sub claude_usage {
  my ($line) = @_;
  return unless $line =~ /(?<!\\)"stop_sequence":(?:null|"(?:[^"\\]|\\.)*"),(?:"stop_details":(?:null|\{(?:[^{}]|\{[^{}]*\})*\}),)?"usage":\{/g;
  my $u = substr($line, pos($line));
  my %n;
  for my $k (qw(input_tokens cache_creation_input_tokens cache_read_input_tokens output_tokens ephemeral_1h_input_tokens ephemeral_5m_input_tokens)) {
    $n{$k} = $u =~ /"\Q$k\E":(\d+)/ ? $1 : 0;
  }
  return \%n;
}

# a reply Claude Code made up (an API error, a limit reached): no request, no usage
sub is_synthetic { return index($_[0], '"model":"<synthetic>"') >= 0 }

sub codex_counts {
  my ($line, $key) = @_;
  my $at = index($line, "\"$key\":{");
  return if $at < 0;
  my $u = substr($line, $at);
  my %n;
  for my $k (qw(input_tokens cached_input_tokens output_tokens total_tokens)) { $n{$k} = $u =~ /"\Q$k\E":(\d+)/ ? $1 : 0 }
  return \%n;
}

sub ctx {
  my ($file) = @_;
  print "==> $file\n";
  open(my $fh, '<', $file) or return;
  my $size = -s $fh;
  seek($fh, $size > 262144 ? $size - 262144 : 0, 0);
  my $found;
  while (my $line = <$fh>) {
    if (is_rollout($file)) {
      next unless index($line, '"type":"token_count"') >= 0;
      my $n = codex_counts($line, 'last_token_usage') or next;
      my $window = $line =~ /"model_context_window":(\d+)/ ? $1 : '';
      $found = "$n->{total_tokens} $window";
    } else {
      next unless $line =~ /(?<!\\)"role":"assistant"/;
      next if $line =~ /^\{[^{]*?"isSidechain":true/ || is_synthetic($line);
      my $n = claude_usage($line) or next;
      $found = $n->{input_tokens} + $n->{cache_creation_input_tokens} + $n->{cache_read_input_tokens};
    }
  }
  close $fh;
  $found =~ s/ $// if defined $found;
  print "ctx $found\n" if defined $found;
}

sub scan {
  my ($file, $offset, $mark, $since, $seen) = @_;
  print "==> $file\n";
  open(my $fh, '<', $file) or do { print "<== $offset\t$mark\n"; return };
  my $size = -s $fh;
  my $rollout = is_rollout($file);
  # read again from the start: what the mark says is of the file as it was
  ($offset, $mark) = (0, '') if $offset > $size;
  seek($fh, $offset, 0);
  my $done = $offset;
  my (%sum, %limit);
  my ($last, $counted) = $mark =~ /^([^,\t]+),(\d+)$/ ? ($1, $2) : ('', 0);
  my ($tin, $tcached, $tout, $cwd) = (0, 0, 0, '');
  if ($rollout && $mark =~ /^(\d+),(\d+),(\d+)(?:\t(.*))?$/s) { ($tin, $tcached, $tout, $cwd) = ($1, $2, $3, $4 // '') }
  while (my $line = <$fh>) {
    # a line still being written is left for the next scan
    last unless substr($line, -1) eq "\n";
    $done = tell($fh);
    if ($rollout) {
      if (index($line, '"type":"turn_context"') >= 0 || index($line, '"type":"session_meta"') >= 0) {
        $cwd = $1 if $line =~ /(?<!\\)"cwd":"((?:[^"\\]|\\.)*)"/;
        next;
      }
      next unless index($line, '"type":"token_count"') >= 0;
      my $time = $line =~ /^\{"timestamp":"([^"]+)"/ ? $1 : '';
      if (my $n = codex_counts($line, 'total_token_usage')) {
        # a count lower than the last: the totals started over (a new process on the same conversation)
        my $over = $n->{input_tokens} < $tin || $n->{cached_input_tokens} < $tcached || $n->{output_tokens} < $tout;
        my @add = $over
          ? ($n->{input_tokens}, $n->{cached_input_tokens}, $n->{output_tokens})
          : ($n->{input_tokens} - $tin, $n->{cached_input_tokens} - $tcached, $n->{output_tokens} - $tout);
        ($tin, $tcached, $tout) = ($n->{input_tokens}, $n->{cached_input_tokens}, $n->{output_tokens});
        if ($time ge $since && ($add[0] || $add[1] || $add[2])) {
          my $at = $sum{join("\t", 'X', slot($time), $cwd)} //= [0, 0, 0];
          $at->[$_] += $add[$_] for 0 .. 2;
        }
      }
      # Codex's own limit only: another model's (as GPT-5.3-Codex-Spark's) has windows of the same lengths
      my $limit_id = $line =~ /"rate_limits":\{"limit_id":"([^"]*)"/ ? $1 : 'codex';
      next unless $limit_id eq 'codex';
      for my $which (qw(primary secondary)) {
        next unless $line =~ /"\Q$which\E":\{([^{}]*)\}/;
        my $l = $1;
        next unless $l =~ /"used_percent":([\d.]+)/;
        my $used = $1;
        next unless $l =~ /"window_minutes":(\d+)/;
        my $minutes = $1;
        my $resets = $l =~ /"resets_at":(\d+)/ ? $1 : '';
        $limit{$minutes} = "L\t$time\t$used\t$minutes\t$resets";
      }
    } else {
      next unless $line =~ /(?<!\\)"role":"assistant"/;
      next if is_synthetic($line);
      my $id = $line =~ /"id":"(msg_[A-Za-z0-9_]+)"/ ? $1 : next;
      my $time = last_string($line, 'timestamp') // next;
      my $n = claude_usage($line) or next;
      my $model = $line =~ /"model":"([^"\\]*)"/ ? $1 : '';
      my $where = last_string($line, 'cwd') // '';
      my @add;
      if ($id eq $last) {
        # the same reply written on: only what its output grew by
        my $more = $n->{output_tokens} - $counted;
        next if $more <= 0;
        $counted = $n->{output_tokens};
        @add = (0, 0, 0, 0, $more);
      } else {
        # counted already, here or in another transcript (a continued conversation copies its history)
        next if $seen->{$id};
        $seen->{$id} = 1;
        ($last, $counted) = ($id, $n->{output_tokens});
        my $one_hour = $n->{ephemeral_1h_input_tokens};
        my $five = $n->{cache_creation_input_tokens} - $one_hour;
        $five = 0 if $five < 0;
        @add = ($n->{input_tokens}, $five, $one_hour, $n->{cache_read_input_tokens}, $n->{output_tokens});
        print "I\t$id\t", slot($time), "\n" if $time ge $since;
      }
      next if $time lt $since;
      my $at = $sum{join("\t", 'C', slot($time), $model, $where)} //= [0, 0, 0, 0, 0];
      $at->[$_] += $add[$_] for 0 .. 4;
    }
  }
  close $fh;
  print join("\t", $_, @{ $sum{$_} }), "\n" for sort keys %sum;
  print "$limit{$_}\n" for sort { $a <=> $b } keys %limit;
  print "<== $done\t", ($rollout ? "$tin,$tcached,$tout\t$cwd" : $last eq '' ? '' : "$last,$counted"), "\n";
}

# the 10-minute slot an ISO time falls in: `2026-10-11T02:17:40.1Z` is `2026-10-11T02:10`
sub slot { return substr($_[0], 0, 15) . '0' }
