var total_api_requests = 0;
var remaining_hits = 200;
var remaining_lookup = {};
var confirmed_api = false;
var now = new Date();
var twitter_api_prefix = 'https://api.twitter.com/1.1'

var whitelist;

/* A simple throbber, for the lols and bonus internets. */
function throbber() {
    throbber.pos += 1;
    if(throbber.pos > throbber.animation.length - 1) throbber.pos = 0;
    return throbber.animation[throbber.pos];
}
throbber.pos = 0;
throbber.animation = ["|","/","-","\\"];

/* Wrapper function for logging the progress. Utilizes the throbber. */
function log(msg, extra) {
    $("#progress").html("[" + throbber() +"] " + msg).prop("title", extra ? extra : "");
}

function compare_numerically(a, b) {
    return a - b;
}

function compare_humanly(a, b) {
    return a.toLowerCase() - b.toLowerCase();
}

/***/

function CounterCallback(count, callback) {
    /* Returns a function that triggers `callback` after being called `count` times. */

    this.count = count;
    this.callback = callback;

    var self = this;
    return function() { self.next(); }
}

CounterCallback.prototype.next = function() {
    this.count--;
    if(this.count <= 0) this.callback();
}

/***/

function TweepSet(label, target) {
    /* Container for TweepSets */
    this.label = label;
    this.target = target;
    this.members = new Array();
    this.manifest = {};
    this.count = 0;
}

TweepSet.prototype.set_population = function(population) {
    /* Initialize the column and compute the manifest hash table */
    this.count = population.length;
    $(this.target).empty().append("<h2>" + this.label + " <span class=\"number\">(" + this.count + ")</span></h2><ul></ul>");

    var self = this;
    $.each(population, function(i, id) { self.manifest[id] = true; });
}

TweepSet.prototype.add_member = function(tweep, fade) {
    /* If tweep is a member, insert it in sorted order */
    if(!this.manifest[tweep.id]) return;

    this.manifest[tweep.id] = false; // Nullify it for the future

    var pos = insert_index(this.members, tweep.screen_name, function(a, b) { return a.toLowerCase() < b.toLowerCase() })
    var row = $("<li></li>").html('<a href="http://twitter.com/'+ tweep.screen_name +'" target="_blank">'+ tweep.screen_name +'</a>');

    var last_tweet = tweep['status'] && Date.parse(tweep['status']['created_at']);
    if(last_tweet && now - last_tweet > 3*30*24*60*60*1000) { // 3 months
        $("a", row).append(' <i class="twitter_sprite stale" title="Inactive for more than 3 months."></i>');
    }

    var created_at = new Date(tweep['created_at']);
    var age_days = Math.round((new Date() - created_at) / (1000.0 * 60 * 60 * 24));
    var tweet_rate = Number(tweep['statuses_count'] / age_days).toFixed(1);
    tweep['created_year'] = created_at.getFullYear();
    tweep['tweet_rate'] = tweet_rate;

    if (tweet_rate > 10) {
        $("a", row).append(' <i class="twitter_sprite loud" title="'+ tweet_rate +' tweets per day."></i>');
    }
    if (xoxo_whitelist[tweep.id]) {
        $("a", row).append(' <i class="twitter_sprite xoxo" title="Attending XOXO 2014"></i>');
    }

    row[0].info = tweep;
    decorate_tweep(row);

    if(fade) row.addClass("hidden").hide();

    this.members.splice(pos, 0, tweep.screen_name);

    if(pos==0) {
        $("ul", this.target).prepend(row);
    } else {
        $("ul li:nth-child(" + pos + ")", this.target).after(row);
    }
}

/***/

function get_min_limit() {
    var min_percents = $.map(remaining_lookup, function(v, k) { return v.percent; });
    return Math.min.apply(Math, min_percents);
}

function check_limit(success_callback) {
    /* Fetch the current remaining_hits status for the user's Twitter API. */
    log("Checking Twitter API query limits.");

    var targets = [
        {name: 'friends', resource: '/friends/ids'},
        {name: 'followers', resource: '/followers/ids'},
        {name: 'lists', resource: '/lists/members'},
        {name: 'users', resource: '/users/lookup'}
    ];
    var resource_list_str = $(targets).map(function(i, o) { return o.name }).toArray().join(',');
    var api_target = "/application/rate_limit_status.json?resources=" + resource_list_str;

    return query_twitter(api_target, {}, function(data) {
        var all_remaining = $(targets).map(function(i, o) {
            var r = data['resources'][o.name][o.resource];
            remaining_lookup[o.resource] = r;
            r.percent = (r.remaining / r.limit) * 100;
            return r.remaining;
        });
        remaining_hits = Math.min.apply(Math, all_remaining);
        success_callback();
    });
}

function get_followx(type, screen_name, callback) {
    var users_hash = {};
    var users_array = [];

    function with_paging(cursor) {
        query_twitter("/" + type + "/ids.json", {screen_name: screen_name, cursor: cursor}, function(data) {
            $.each(data.ids, function(i, id) { users_hash[id] = true; users_array.push(id); });

            if(data.next_cursor && data.next_cursor > 0) {
                with_paging(data.next_cursor);
            } else {
                callback(users_hash, users_array.sort(compare_numerically));
            }
        });
    }
    with_paging(-1);
}

function get_following(screen_name, callback) { get_followx("friends", screen_name, callback); }
function get_followers(screen_name, callback) { get_followx("followers", screen_name, callback); }

function get_social_ids(screen_name, callback) {
    log("Loading social network counts.");
    var only_followers = new Array();
    var only_following = new Array();
    var mutual = new Array();

    get_following(screen_name, function(following_hash, following) {
        get_followers(screen_name, function(followers_hash, followers) {
            /// TODO: This could be done better...
            load_diffs(following, followers, only_followers, only_following, mutual);

            callback({
                only_followers: only_followers,
                only_following: only_following,
                mutual: mutual,
                following: following,
                following_hash: following_hash,
                followers: followers,
                followers_hash: followers_hash
            });
        });
    });
}

/* Confirmation message for when we're starting to get low on remaining hits. */
function confirm_api() {
    if(get_min_limit() < 15) {
        log("Getting dangerously close to getting banned from Twitter. No more requests for a while, please.");
        return false;
    }
    confirmed_api = confirmed_api || confirm("Warning: Performing too many queries on the Twitter API could cause Twitter to block you temporarily.\n\nYou have " + Math.round(get_min_limit()) + "% of your queries remaining for the next 15 minutes, are you sure you want to continue?\n\n(Safest to wait 15 minutes and try again.)");
    return confirmed_api;
}

function query_twitter(api_target, params, callback) {
    var remaining = remaining_lookup[api_target];
    if (remaining) {
        remaining.remaining -= 1;
        remaining.percent = (remaining.remaining / remaining.limit) * 100;
    }
    total_api_requests += 1;

    var target_url = twitter_api_prefix + api_target;
    return OAuth.getJSON(target_url, params, callback, function() {
        // Retry one more time for kicks:
        return OAuth.getJSON(target_url, params, callback, function() {
            log("Twitter API is suffering from epic failulitis. Refresh and hope for the best?");
        });
    });
}

function load_twitter(api_target, cursor, item_callback, iter_callback, success_callback) {
    return query_twitter(api_target, {'cursor': cursor}, function(data) {
        if(data.error) {
            log("Twitter returned an error: " + data.error);
            return;
        }
        $.each(data.users, function(i, item) { item_callback(item); });

        if($.isFunction(iter_callback)) iter_callback(data.users.length);

        if(data.next_cursor && data.next_cursor > 0 && (get_min_limit() > 35 || confirm_api())) {
            load_twitter(api_target, data.next_cursor, item_callback, iter_callback, success_callback);
        } else {
            if($.isFunction(success_callback)) success_callback();
        }
    });
}

function load_followers(username, item_callback, iter_callback, success_callback) {
    var api_target = "/followers/list.json?screen_name=" + username;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_following(username, item_callback, iter_callback, success_callback) {
    var api_target = "/friends/list.json?screen_name=" + username;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_list_members(username, slug, item_callback, iter_callback, success_callback) {
    var api_target = "/lists/members.json?owner_screen_name=" + username + "&slug=" + slug;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_users(user_ids, item_callback, iter_callback, success_callback) {
    var api_target = "/users/lookup.json";

    function get_user_ids() {
        var ids = [];
        for(var i=100; i>0; i--) {
            var id = user_ids.shift();
            if(!id) break;
            ids.push(id);
        }
        return ids;
    }

    function callback(data) {
        if(data) {
            if(data.error) {
                log("Twitter returned an error: " + data.error);
                return;
            }
            $.each(data, function(i, item) { item_callback(item); });
            if($.isFunction(iter_callback)) iter_callback(data.length);
        }

        var ids = get_user_ids().join(',');
        if(!ids) {
            if($.isFunction(success_callback)) success_callback();
            return;
        }

        if (get_min_limit() > 35 || confirm_api()) {
            query_twitter(api_target, {'user_id': ids}, callback);
        }
    }

    // Commence recursing
    callback();
}


function generate_whitelist(username, slug) {
    whitelist = {};
    load_list_members(username, slug, function(item) {
        whitelist[item.id] = true;
    });
}

function load_diffs(following, followers, only_followers, only_following, mutual) {
    /* Calculate the set differences between the ``following`` and ``followers`
     * and shove them into the appropriate arrays.
     */
    $.each(following, function(i, item) {
        if(!in_array(followers, item)) {
            only_following.push(item);
        } else {
            mutual.push(item);
        }
    });

    $.each(followers, function(i, item) {
        if(!in_array(following, item)) {
            only_followers.push(item);
        }
    });
}


var RE_TMPL = /{{([\w\s]+?)}}/g;
var template_cache = {};

function render_template(template_name, context) {
    var html = template_cache[template_name];
    if(!html) {
        html = $("#templates #" + template_name).remove().html();
        html = html.replace("%7B%7B", "{{").replace(/%20/g, " ").replace("%7D%7D", "}}"); // Fix src
        template_cache[template_name] = html;
    }
    var ctx = html.match(RE_TMPL);
    $.each(ctx, function(i, v) {
        var v_stripped = this.substr(2, this.length-4); // Cut out the braces
        v_stripped = $.trim(v_stripped);
        var val = context[v_stripped];
        if(val!=undefined) html = html.replace(this, val);
    });

    return html;
}

function decorate_tweep(item) {
    $(item).hover(
        function() {
            var info  = this.info;
            info['friends_count'] = info['friends_count'] || 0;
            info['followers_count'] = info['followers_count'] || 0;
            info['last_tweet'] = (info['status'] && relative_time(info['status']['created_at'])) || "never made";

            var html = $(render_template("floating_info_template", info));

            var self = this;
            $(".follow", html).click(function() {
                follow(info.screen_name);
                $(self).removeClass("unfollowed");
                $(self).addClass("followed");
            });
            $(".unfollow", html).click(function() {
                unfollow(info.screen_name);
                $(self).removeClass("followed");
                $(self).addClass("unfollowed");
            });
            this.floating_info = html;
            $(this).append(html);
            $(this).addClass("floating_row");
        },
        function() {
            $(this).removeClass("floating_row");
            $(this.floating_info).remove();
        }
    );
}

function set_thanks_text(s, variation_label) {
    var href = 'https://twitter.com/home?status=' + encodeURI(s);
    $(".thanks-link").attr('href', href);
}

function show_thanks(num_mutual, num_stalking, num_stalkers) {
    // "A-B test" the message, for funsies.
    if (Math.random() < 0.5) {
        set_thanks_text("Found my Twitter stalkers using Tweepsect (" + num_stalkers + " stalkers and " + num_mutual +" mutual friends), try it! http://tweepsect.com/", 1);
    } else {
        set_thanks_text("Found my " + num_stalkers + " stalkers on Twitter (and " + num_mutual + " mutual friends) by using Tweepsect, try it out! http://tweepsect.com/", 2);
    }
}

function parse_username(input) {
    if(input[0] == "@") return {username: input.substr(1)};
    if(input.indexOf("://") >= 0) {
        // Parse list
        input = input.split(".com/", 2)[1];
        if(input[0] == "#") input = input.split("#!/", 2)[1];
        var parts = input.split("/", 2);
        return {
            username: parts[0],
            listname: parts[1].split("/")[1]
        }
    }
    return {username: input};
}

function get_results() {
    $("#intro").hide();
    ga('send', 'pageview', '/query');

    var input = $("#username").prop("value");
    if(!input) {
        log("Pick a tweep means put a Twitter username in the input box, like 'shazow'. Try it.");
        return;
    }
    var p = parse_username(input);
    var username = p.username;
    var listname = p.listname;

    var tset_mutual = new TweepSet("Mutual", $("#mutual"));
    var tset_only_following = new TweepSet("Stalking", $("#only_following"));
    var tset_only_followers = new TweepSet("Stalkers", $("#only_followers"));

    var time_start = (new Date).getTime();
    var MAX_FADE = 1000; // When there's too much on the screen, it gets laggy

    check_limit(function() {
        var hits_start = total_api_requests;

        get_social_ids(username, function(r) {
            var expected_total = r['followers'].length + r['following'].length;
            var processed_count = 0;

            // Fill the TweepSet columns
            tset_mutual.set_population(r['mutual']);
            tset_only_following.set_population(r['only_following']);
            tset_only_followers.set_population(r['only_followers']);

            show_thanks(tset_mutual.count, tset_only_following.count, tset_only_followers.count);

            function render_item(item) {
                /* (Called for every item) Notify each TweepSet of a potential new member */
                if(whitelist && !whitelist[item.id]) return; // Descriminate against this tweep.
                var fade = processed_count < MAX_FADE;
                tset_mutual.add_member(item, fade);
                tset_only_following.add_member(item, fade);
                tset_only_followers.add_member(item, fade);
            }

            function iter_callback(num) {
                /* (Called for every query) Perform fade and update progress */
                var fade = processed_count < MAX_FADE;
                if(fade) $(".hidden").removeClass("hidden").fadeIn();

                processed_count += num;
                log("Fetching tweeps: " + Math.round((processed_count / expected_total) * 100) + "%");
            }

            function completed() {
                /* Callback to trigger when both parallel AJAX chains are done */
                var time_elapsed = (new Date).getTime() - time_start;
                log("Done! Loaded " + processed_count + " tweeps using " + (total_api_requests - hits_start) + " API calls in " + time_elapsed/1000 + " seconds.");
            }

            log("Fetching tweeps: 0%");

            if(!listname) {
                // Start parallel AJAX chains, wee
                var c = new CounterCallback(3, completed);
                load_users(r['mutual'], render_item, iter_callback, c);
                load_users(r['only_following'], render_item, iter_callback, c);
                load_users(r['only_followers'], render_item, iter_callback, c);
            } else {
                load_list_members(username, listname, render_item, iter_callback, completed);
            }
        });
    });
}

function unfollow(screen_name) {
    log("Unfollowing...");
    var api_target = twitter_api_prefix + "/friendships/destroy.json?screen_name=" + screen_name;

    OAuth.post(api_target, {}, function() {
        log("Unfollowed: " + screen_name);
    });
}

function follow(screen_name) {
    log("Following...");
    var api_target = twitter_api_prefix + "/friendships/create.json?screen_name=" + screen_name;

    OAuth.post(api_target, {}, function() {
        log("Followed: " + screen_name);
    });
}

function tweepsect(screen_name) {
    $("#username").prop("value", screen_name);
    get_results();
}

/***/


// Based on:
//+ Carlos R. L. Rodrigues
//@ http://jsfromhell.com/array/search [rev. #2]
// Modified by Andrey Petrov for simplicity.
in_array = function(o, v) {
    /* For sorted array o, find v using binary search, returns bool */
    var h = o.length, l = -1, m;
    while(h - l > 1)
        if(o[m = h + l >> 1] < v) l = m;
        else h = m;
    return o[h] == v;
};

insert_index = function(o, v, cmp) {
    /* For sorted array o, return appropriate index position to insert v, using binary search */
    if(!cmp) {
        var cmp = function(a, b) { return a < b; };
    }
    var h = o.length, l = -1, m;
    while(h - l > 1)
        if(cmp(o[m = h + l >> 1], v)) l = m;
        else h = m;
    return h;
};

/* Borrowed from http://github.com/seaofclouds/tweet/ */
function relative_time(time_value) {
    var parsed_date = Date.parse(time_value);
    var relative_to = (arguments.length > 1) ? arguments[1] : new Date();
    var delta = parseInt((relative_to.getTime() - parsed_date) / 1000);
    if(delta < 60) {
    return 'less than a minute ago';
    } else if(delta < 120) {
    return 'about a minute ago';
    } else if(delta < (45*60)) {
    return (parseInt(delta / 60)).toString() + ' minutes ago';
    } else if(delta < (119*60)) {
    return 'about an hour ago';
    } else if(delta < (24*60*60)) {
    return 'about ' + (parseInt(delta / 3600)).toString() + ' hours ago';
    } else if(delta < (48*60*60)) {
    return '1 day ago';
    } else {
    return (parseInt(delta / 86400)).toString() + ' days ago';
    }
}

function track_links(selector, category) {
    $('a', selector).on('click', function(e) {
        var url = $(this).attr("href");
        if (e.currentTarget.host != window.location.host) {
            var is_new_tab = e.metaKey || e.ctrlKey || this.target == "_blank";
            var ga_event = {
                'hitType': 'event',
                'eventCategory': category,
                'eventAction': 'click',
                'eventLabel': url.split("?")[0] // Don't track query args.
            };
            if (is_new_tab) {
                ga('send', ga_event);
                return true;
            }

            ga_event['hitCallback'] = function() {
                document.location = url;
            };
            ga('send', ga_event);

            e.preventDefault();
            return false;
        }
    });
};


var xoxo_whitelist = {"409":1,"414":1,"422":1,"448":1,"541":1,"882":1,"949":1,"1084":1,"1154":1,"1186":1,"1598":1,"1821":1,"2185":1,"2549":1,"2984":1,"3922":1,"4396":1,"4987":1,"4999":1,"5017":1,"5107":1,"5117":1,"5215":1,"5504":1,"5699":1,"5813":1,"6033":1,"6417":1,"6595":1,"6822":1,"6854":1,"7161":1,"7801":1,"7833":1,"8877":1,"9457":1,"10051":1,"10350":1,"10423":1,"10714":1,"10822":1,"10881":1,"11113":1,"11628":1,"11724":1,"11868":1,"12249":1,"12279":1,"12294":1,"12513":1,"12615":1,"12685":1,"12877":1,"12891":1,"12914":1,"12938":1,"13035":1,"13341":1,"13349":1,"13461":1,"13576":1,"14563":1,"15033":1,"16023":1,"18713":1,"21883":1,"22483":1,"24263":1,"25663":1,"26233":1,"26853":1,"30923":1,"33053":1,"33423":1,"33883":1,"34303":1,"35603":1,"36253":1,"36443":1,"36823":1,"38093":1,"38753":1,"41713":1,"41783":1,"43273":1,"46063":1,"46343":1,"49093":1,"51123":1,"51203":1,"54913":1,"57203":1,"57743":1,"65233":1,"74523":1,"78493":1,"83673":1,"86263":1,"109023":1,"112613":1,"128163":1,"182383":1,"187793":1,"289403":1,"302173":1,"379983":1,"409493":1,"460493":1,"482433":1,"509323":1,"514063":1,"616673":1,"633793":1,"635793":1,"638773":1,"641013":1,"643403":1,"647403":1,"649633":1,"651733":1,"656233":1,"657073":1,"666073":1,"673443":1,"675863":1,"680703":1,"681523":1,"682373":1,"682463":1,"695243":1,"716923":1,"734203":1,"754604":1,"755241":1,"755414":1,"755594":1,"756466":1,"758011":1,"759287":1,"760795":1,"761975":1,"763281":1,"768632":1,"771619":1,"772667":1,"774010":1,"774280":1,"778325":1,"782010":1,"784128":1,"784710":1,"784912":1,"785347":1,"787158":1,"792690":1,"793214":1,"794767":1,"796601":1,"798952":1,"802112":1,"804325":1,"804774":1,"805382":1,"807657":1,"810667":1,"812567":1,"813637":1,"814176":1,"816016":1,"817394":1,"818902":1,"818992":1,"820115":1,"821753":1,"822030":1,"823012":1,"823129":1,"823207":1,"824022":1,"852251":1,"862681":1,"869201":1,"875511":1,"876081":1,"883321":1,"896061":1,"925161":1,"930061":1,"944261":1,"956501":1,"956611":1,"962801":1,"980641":1,"1008061":1,"1008591":1,"1048651":1,"1063491":1,"1105671":1,"1124861":1,"1133701":1,"1154511":1,"1184251":1,"1206581":1,"1262791":1,"1266241":1,"1270851":1,"1290621":1,"1317661":1,"1318181":1,"1380471":1,"1422311":1,"1459461":1,"1465161":1,"1465481":1,"1477481":1,"1523501":1,"1530531":1,"1532061":1,"1586871":1,"1592491":1,"1617891":1,"1636901":1,"1747381":1,"1755171":1,"1781201":1,"1788381":1,"1797691":1,"1813571":1,"1853211":1,"1854211":1,"1919231":1,"2052011":1,"2052331":1,"2219131":1,"2254561":1,"2326161":1,"2386451":1,"2399381":1,"2404341":1,"2563081":1,"2622731":1,"2790981":1,"2897431":1,"3076531":1,"3080761":1,"3137231":1,"3163591":1,"3174971":1,"3225381":1,"3361621":1,"3394331":1,"3642001":1,"3688491":1,"3985601":1,"4195221":1,"4439191":1,"4531551":1,"4829901":1,"4930131":1,"4934171":1,"5056501":1,"5162961":1,"5273561":1,"5380022":1,"5382252":1,"5389182":1,"5418912":1,"5424182":1,"5468302":1,"5473342":1,"5603992":1,"5656302":1,"5663182":1,"5693882":1,"5706532":1,"5746882":1,"5749022":1,"5777542":1,"5778712":1,"5793622":1,"5803082":1,"5867112":1,"5867532":1,"5905672":1,"5943422":1,"6016232":1,"6088382":1,"6121442":1,"6144932":1,"6148712":1,"6152702":1,"6154922":1,"6160742":1,"6194102":1,"6316232":1,"6326912":1,"6352012":1,"6352892":1,"6368672":1,"6442312":1,"6490642":1,"6503412":1,"6512322":1,"6514492":1,"6588972":1,"6646752":1,"6666892":1,"6714782":1,"6728562":1,"6757422":1,"6775512":1,"6875952":1,"6981492":1,"7001722":1,"7026992":1,"7054972":1,"7118672":1,"7157722":1,"7191382":1,"7215612":1,"7234652":1,"7284142":1,"7343762":1,"7359642":1,"7535272":1,"7596052":1,"7603032":1,"7669762":1,"7686862":1,"7742162":1,"7801382":1,"7933932":1,"7975582":1,"8039302":1,"8067082":1,"8072642":1,"8190802":1,"8207832":1,"8252462":1,"8253682":1,"8255402":1,"8308622":1,"8315692":1,"8363602":1,"8390102":1,"8419232":1,"8485792":1,"8492382":1,"8501542":1,"8552602":1,"8618132":1,"8632762":1,"8752222":1,"8761172":1,"8848952":1,"8940312":1,"8946022":1,"8950822":1,"8975702":1,"9255782":1,"9270952":1,"9338922":1,"9361392":1,"9368412":1,"9378282":1,"9428232":1,"9445792":1,"9463402":1,"9641922":1,"9866582":1,"9879342":1,"9895472":1,"9987762":1,"10137552":1,"10267352":1,"10360752":1,"10369032":1,"10724012":1,"10791832":1,"10914232":1,"10961962":1,"11098142":1,"11325252":1,"11407702":1,"11491312":1,"11519102":1,"11735032":1,"11760342":1,"11856072":1,"11888112":1,"11927552":1,"11957472":1,"12040482":1,"12070592":1,"12091452":1,"12096622":1,"12145232":1,"12175632":1,"12248262":1,"12294442":1,"12377532":1,"12377822":1,"12421082":1,"12535362":1,"12668332":1,"12772732":1,"12803032":1,"12920742":1,"12992142":1,"13103182":1,"13335562":1,"13443702":1,"13458372":1,"13800412":1,"13860742":1,"13940602":1,"13980622":1,"14052194":1,"14052373":1,"14069365":1,"14097026":1,"14099692":1,"14112869":1,"14113407":1,"14115059":1,"14116243":1,"14125871":1,"14137737":1,"14137882":1,"14150168":1,"14155739":1,"14166501":1,"14167197":1,"14177564":1,"14178728":1,"14180531":1,"14186026":1,"14187249":1,"14189112":1,"14195880":1,"14198319":1,"14199907":1,"14204909":1,"14211807":1,"14211882":1,"14220606":1,"14221104":1,"14224219":1,"14253068":1,"14255152":1,"14263159":1,"14271974":1,"14272503":1,"14288769":1,"14303235":1,"14303954":1,"14312845":1,"14328463":1,"14328506":1,"14330980":1,"14331929":1,"14353975":1,"14356969":1,"14370184":1,"14380400":1,"14397792":1,"14414761":1,"14417135":1,"14471007":1,"14475298":1,"14483134":1,"14510231":1,"14515931":1,"14539307":1,"14541533":1,"14550221":1,"14569079":1,"14574586":1,"14579982":1,"14592020":1,"14607687":1,"14614857":1,"14621681":1,"14628992":1,"14629724":1,"14669224":1,"14688344":1,"14697012":1,"14699828":1,"14701006":1,"14716358":1,"14731011":1,"14731905":1,"14763721":1,"14767632":1,"14780589":1,"14800329":1,"14806423":1,"14807853":1,"14819309":1,"14819901":1,"14829295":1,"14833752":1,"14859264":1,"14860638":1,"14893547":1,"14903327":1,"14903883":1,"14927869":1,"14934367":1,"14947406":1,"14971414":1,"14980933":1,"14983480":1,"14997350":1,"15024090":1,"15049042":1,"15059001":1,"15069435":1,"15071058":1,"15098106":1,"15151706":1,"15159177":1,"15162920":1,"15169697":1,"15172760":1,"15220688":1,"15226263":1,"15239461":1,"15330898":1,"15334523":1,"15345209":1,"15375030":1,"15387870":1,"15390595":1,"15399279":1,"15416046":1,"15428098":1,"15468077":1,"15510016":1,"15537315":1,"15569730":1,"15586792":1,"15604398":1,"15608541":1,"15612035":1,"15617576":1,"15642029":1,"15660494":1,"15662190":1,"15680611":1,"15681643":1,"15682773":1,"15683403":1,"15706128":1,"15723203":1,"15729558":1,"15743396":1,"15763404":1,"15805450":1,"15875557":1,"15876113":1,"15884541":1,"15938093":1,"15947897":1,"16000132":1,"16005107":1,"16022565":1,"16062625":1,"16125720":1,"16252989":1,"16266780":1,"16271827":1,"16286091":1,"16328976":1,"16331614":1,"16331904":1,"16352915":1,"16392799":1,"16393886":1,"16428140":1,"16437301":1,"16467582":1,"16479659":1,"16483747":1,"16515082":1,"16522656":1,"16523003":1,"16570302":1,"16588791":1,"16655768":1,"16663324":1,"16729508":1,"16741826":1,"16784490":1,"16799897":1,"16915910":1,"16933425":1,"17025934":1,"17035875":1,"17046072":1,"17092251":1,"17105539":1,"17142606":1,"17177251":1,"17182189":1,"17192686":1,"17271356":1,"17273108":1,"17296176":1,"17341184":1,"17343876":1,"17345949":1,"17355558":1,"17391571":1,"17426875":1,"17430997":1,"17431654":1,"17432389":1,"17474988":1,"17532167":1,"17576659":1,"17742902":1,"17760048":1,"17814720":1,"17846813":1,"17878608":1,"17917257":1,"17984137":1,"18069838":1,"18092335":1,"18128940":1,"18152849":1,"18183018":1,"18187207":1,"18196758":1,"18212523":1,"18214494":1,"18229128":1,"18246193":1,"18317000":1,"18330119":1,"18348795":1,"18375989":1,"18405153":1,"18418077":1,"18441310":1,"18468638":1,"18665414":1,"18692309":1,"18695490":1,"18708466":1,"18775572":1,"18776317":1,"18818340":1,"18824526":1,"18908446":1,"18988502":1,"19006569":1,"19035047":1,"19084002":1,"19153715":1,"19193287":1,"19194936":1,"19210074":1,"19238265":1,"19254864":1,"19268965":1,"19333113":1,"19612480":1,"19745353":1,"19818279":1,"19895045":1,"19923571":1,"19924413":1,"19982776":1,"20021667":1,"20110439":1,"20122655":1,"20283478":1,"20384189":1,"20420722":1,"20666150":1,"20691442":1,"20729281":1,"20811622":1,"20825732":1,"20949658":1,"20967772":1,"21059960":1,"21166130":1,"21338196":1,"21459150":1,"21500149":1,"21798005":1,"22066285":1,"22118364":1,"22449932":1,"22856668":1,"22921281":1,"22980944":1,"23020351":1,"23141171":1,"23264033":1,"23320205":1,"23339129":1,"23452484":1,"23487429":1,"24499115":1,"24662583":1,"24752584":1,"24989688":1,"25219946":1,"25325530":1,"25401571":1,"25845867":1,"25890180":1,"25958131":1,"26254626":1,"26305496":1,"26430983":1,"26465257":1,"26612436":1,"26706833":1,"27809570":1,"27993405":1,"28286772":1,"28363528":1,"29089557":1,"29100735":1,"29458070":1,"29731936":1,"29983456":1,"30391561":1,"30689021":1,"30732254":1,"30948908":1,"30949085":1,"31182608":1,"31478923":1,"31664653":1,"31665210":1,"31977286":1,"32124032":1,"32166655":1,"34030003":1,"34342176":1,"34387624":1,"34501014":1,"34517654":1,"34608722":1,"34951303":1,"36391242":1,"36788811":1,"36994785":1,"37008538":1,"37061669":1,"37143407":1,"39815274":1,"40262799":1,"40437414":1,"40596237":1,"40959851":1,"41541749":1,"41676703":1,"42569621":1,"42677879":1,"42750234":1,"43030995":1,"43327200":1,"43380643":1,"43473059":1,"43560706":1,"44683117":1,"45354922":1,"45467344":1,"45770468":1,"45784665":1,"45856544":1,"45976653":1,"47840605":1,"48188423":1,"48569578":1,"48913382":1,"50441614":1,"50781713":1,"50874228":1,"52551079":1,"54185484":1,"54638025":1,"55462730":1,"56210849":1,"56607634":1,"56768257":1,"58082518":1,"58314646":1,"58858319":1,"58939141":1,"58961325":1,"59218280":1,"60187947":1,"60677703":1,"61592079":1,"61697390":1,"61823358":1,"62219107":1,"62530673":1,"63636163":1,"64853040":1,"67202886":1,"67825149":1,"68211507":1,"68981132":1,"69324576":1,"71261579":1,"71351519":1,"72745585":1,"72890671":1,"73619718":1,"74262125":1,"78119315":1,"78119712":1,"80052616":1,"81322895":1,"81879407":1,"82993674":1,"83089937":1,"83996344":1,"85841281":1,"86412031":1,"90028497":1,"90488105":1,"91163320":1,"91410410":1,"91722164":1,"94672487":1,"94846538":1,"97263561":1,"98518430":1,"99886636":1,"101190175":1,"104494489":1,"104745184":1,"106935057":1,"107801105":1,"110716686":1,"111005635":1,"111032147":1,"112075585":1,"112524101":1,"114853731":1,"115560394":1,"118279350":1,"119156670":1,"119978245":1,"121880060":1,"123601500":1,"126854537":1,"127575007":1,"128904040":1,"130584519":1,"130897706":1,"132655885":1,"133058038":1,"133424508":1,"135856194":1,"136400506":1,"138528012":1,"139504833":1,"143209548":1,"143702545":1,"149001999":1,"150764358":1,"152115336":1,"152427726":1,"157097806":1,"158272788":1,"161369987":1,"163202841":1,"166301775":1,"168786885":1,"176233506":1,"180173919":1,"180306193":1,"181703779":1,"182616152":1,"182781508":1,"186833531":1,"190919583":1,"194663014":1,"195485269":1,"195863654":1,"197506631":1,"197896861":1,"198695654":1,"203063180":1,"205931347":1,"208202638":1,"210740328":1,"214668433":1,"218558150":1,"226976689":1,"227384429":1,"228823192":1,"229237555":1,"230355105":1,"237262300":1,"244137444":1,"244268839":1,"248701234":1,"249921736":1,"252672062":1,"258398014":1,"266430754":1,"267571446":1,"269386849":1,"271170435":1,"272591364":1,"277071665":1,"277100051":1,"281602070":1,"282464049":1,"284771521":1,"290879947":1,"291551746":1,"295177545":1,"298656296":1,"305804765":1,"310358968":1,"312292673":1,"322234819":1,"323159151":1,"325044817":1,"334490355":1,"344102160":1,"345108623":1,"348082699":1,"354702266":1,"356445530":1,"361606325":1,"365709939":1,"365743287":1,"369958119":1,"374300583":1,"380132681":1,"384239522":1,"384595521":1,"386316205":1,"390856908":1,"392857249":1,"393187879":1,"395079586":1,"396619347":1,"403697545":1,"415114043":1,"415841157":1,"417372853":1,"421378286":1,"433528915":1,"441299438":1,"442522102":1,"443890146":1,"446580276":1,"448658889":1,"451622038":1,"454676858":1,"461789840":1,"466247755":1,"483160795":1,"484972857":1,"486784693":1,"497734629":1,"505010661":1,"509010059":1,"527123659":1,"543963933":1,"545655040":1,"547064680":1,"556221314":1,"577124971":1,"582995890":1,"614119818":1,"620641874":1,"632372439":1,"720676111":1,"737532842":1,"801832062":1,"811989608":1,"817926673":1,"830275986":1,"833716784":1,"867044976":1,"885210589":1,"887397150":1,"937157598":1,"970428030":1,"971175494":1,"980592128":1,"1030894430":1,"1034100738":1,"1037602843":1,"1081552194":1,"1135186555":1,"1222860967":1,"1321418522":1,"1383137149":1,"1400270070":1,"1403488736":1,"1499456916":1,"1529824129":1,"1535018935":1,"1596549006":1,"1653962647":1,"1716377460":1,"1747323823":1,"1849455895":1,"2192342638":1,"2202601008":1,"2224536139":1,"2298999144":1,"2361849645":1,"2372256686":1,"2451986203":1,"2465248892":1,"2482264920":1,"2519693923":1,"2520815526":1,"2525954834":1,"2579675988":1,"2586191162":1,"2586231302":1,"2586236749":1,"2586262430":1,"2586483258":1,"2586654001":1,"2593828616":1,"2597597528":1,"2776966532":1};
