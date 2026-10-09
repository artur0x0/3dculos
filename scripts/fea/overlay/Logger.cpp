// Synchronous logger for the single-threaded mesh build.
//
// Upstream Logger::init starts an spdlog thread pool. This overlay keeps the
// same Logger::init signature and drops log lines on a null sink, so meshing
// does not spawn a thread and does not need shared memory.
//
// This Source Code Form is subject to the terms of the Mozilla Public License
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at http://mozilla.org/MPL/2.0/.

#include "Logger.hpp"

#include <spdlog/sinks/null_sink.h>

namespace floatTetWild {

std::shared_ptr<spdlog::logger> Logger::logger_;

void Logger::init(bool use_cout, const spdlog::filename_t& filename, bool truncate)
{
    (void)use_cout;
    (void)filename;
    (void)truncate;
    auto sink = std::make_shared<spdlog::sinks::null_sink_st>();
    logger_ = std::make_shared<spdlog::logger>("float-tetwild", sink);
    logger_->set_level(spdlog::level::off);
    spdlog::drop("float-tetwild");
    spdlog::register_logger(logger_);
}

}  // namespace floatTetWild
